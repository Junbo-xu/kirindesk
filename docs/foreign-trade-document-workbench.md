# 外贸单证工作台 Phase 1

## 范围

Phase 1 交付一条真实持久化的外贸单证纵向闭环：产品库 → 快速报价 → QT/PI/SC/CI/PL 联动草稿 → 锁定快照 → PDF 归档 → 客户追踪链接 → 打开、下载、确认事件。

不包含报关单预录单、报关委托书、离线编辑、桌面授权、OCR、支付、自动汇率供应商或生产发布。

## 用户流程与验收

1. 有 `products:manage` 权限的用户维护产品、成本、重量、体积、缩略图和租户自定义字段值；系统字段不可删除。
2. 有 `product_fields:manage` 权限的用户新增、停用、排序或删除租户自定义字段，并指定字段出现于 QT、PI、SC、CI、PL 的哪些文档。
3. 有 `document_sets:manage` 权限的用户创建快速报价，客户和销售订单均可暂时为空并在草稿版本中补录。
4. 同一 `trade_document_set` 的头部和行项目驱动五种单据；保存采用 `expected_version` 乐观锁，所有草稿输出随新版本联动。
5. 成本利润模式需要 `document_financials:view`，且该权限的 `data_scope` 必须覆盖目标产品或单证 owner。无权响应不包含成本价、成本合计、内部费用、毛利或毛利率。
6. 汇率、双币种、折扣、FOB/CIF/EXW、运费、保险、税费和按均摊/货值/重量/体积的费用分摊均使用整数缩放计算，不经过浮点金额运算。
7. 普通装箱按明细行生成独立箱级快照；合并装箱按箱号合并明细并精确汇总重量、体积。PL 固定从锁定/导出快照中的箱级模型输出。
8. 固定模板支持中文、英文、俄文、西班牙语、德语和阿拉伯语，包含主题色、字段显隐、条款、银行信息、LOGO、签章和产品缩略图；阿拉伯语使用 RTL 排版。
9. 有 `document_sets:export` 权限的用户可导出草稿或锁定版本。服务端 Chromium 生成真实 PDF，并将每次导出作为新版本归档到 Files/对象存储。
10. 有 `document_links:manage` 权限的用户为某次不可变导出创建客户链接。原始令牌只返回一次，数据库只保存 SHA-256；链接不自动过期，可手动作废。
11. 匿名客户可打开、下载、幂等确认固定导出。事件写入追加表；重复确认不虚增事件，链接作废后所有匿名入口统一返回 404。
12. `document_sets:lock` 将当前完整内部快照锁定。数据库触发器阻止锁定后修改头部或行项目。
13. LOGO、签章与缩略图在引用时执行 `files:view` scope，导出取字节时再取 `files:view` 与 `files:download` 的交集；同租户但 scope 外的文件 UUID 不可嵌入。

## 数据模型

- `products`：租户产品主数据、售价、受限成本、重量、体积、缩略图和自定义值。
- `product_custom_fields`：租户字段定义、状态、顺序和单据显示范围。
- `trade_document_sets`：五合一单据共享头部、客户/销售订单关联、计价配置、模板配置和锁定快照。
- `trade_document_lines`：产品快照、数量、售价、受限成本、装箱与自定义值。
- `trade_document_exports`：不可修改的 PDF 导出快照、导出版本和 Files 引用。
- `trade_document_share_links`：固定导出引用、哈希令牌、撤销和确认状态。
- `trade_document_public_events`：打开、下载、确认的追加事件。

所有表启用并强制 RLS；跨表关系使用 `(tenant_id, id)` 组合外键。匿名令牌只通过固定 `search_path` 的窄 `SECURITY DEFINER` 函数解析租户和链接 ID，随后重新进入正常租户 RLS 上下文。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET/POST` | `/api/products` | 产品列表、创建 |
| `GET/PATCH` | `/api/products/:id` | 产品详情、更新或停用 |
| `GET/POST` | `/api/product-fields` | 字段目录、创建自定义字段 |
| `PATCH/DELETE` | `/api/product-fields/:id` | 更新或删除自定义字段 |
| `GET/POST` | `/api/document-sets` | 单证列表、快速报价 |
| `GET/PATCH` | `/api/document-sets/:id` | 读取或保存新草稿版本 |
| `POST` | `/api/document-sets/:id/lock` | 锁定不可变快照 |
| `POST` | `/api/document-sets/:id/exports/:documentType` | 生成并归档 PDF |
| `GET` | `/api/document-sets/:id/exports` | 导出版本 |
| `GET` | `/api/document-sets/:id/links` | 链接及事件聚合 |
| `POST/DELETE` | `/api/document-links[/:id]` | 创建或作废链接 |
| `GET` | `/api/public/documents/:token` | 匿名打开固定版本 |
| `GET` | `/api/public/documents/:token/download` | 匿名下载固定 PDF |
| `POST` | `/api/public/documents/:token/confirm` | 匿名确认 |

## 客户数据边界

客户 PDF 和匿名 API 只接受 `PublicDocumentSnapshot`。服务层先将 `InternalDocumentSnapshot` 显式映射为公开投影，再调用 PDF 渲染器；渲染器的类型签名无法接收成本利润字段。公开响应、HTML 和 PDF 均不包含成本价、成本合计、内部费用、毛利或毛利率。

产品与单证的审计 before/after 使用最小公开投影，不写入产品成本、单证成本、内部费用、毛利或毛利率；持有 `audit_logs:view` 但没有对应财务 scope 的用户无法借审计详情绕过保护。

## 迁移与回滚

迁移文件为 `053_foreign_trade_document_workbench.sql`。它新增表、RLS、触发器、权限和既有角色的保守权限映射，不修改已发布迁移。

- 应用回滚：部署上一版 API/Web，保留 053 数据库结构。这是已有一期数据时的首选回滚。
- 数据库回滚：`pnpm db:rollback` 可完整移除 053，但会删除所有一期产品、单证、导出链接和事件数据。仅允许在尚无一期业务数据，或已完成备份且负责人明确批准恢复方案时执行。
- Files 对象：数据库回滚不会自动删除已写入对象存储的 PDF；需要依据 `trade_document_exports.file_id` 和 `files.storage_key` 的回滚前清单执行受控清理。

## 已知风险

- Chromium 与 Noto 字体使 API 运行镜像明显增大；当前实现每次导出启动独立浏览器进程，优先保证隔离和确定性，后续高并发场景需单独评估受控浏览器池与队列。
- 自定义字段删除只影响后续草稿渲染；已锁定快照和历史导出保持原值与标签。
- Phase 1 汇率由用户输入并锁定，不声称已接入实时汇率供应商。
- Web 构建主包约 517 kB，已通过构建但存在拆包优化空间，不影响本期正确性。

## 履约接入 Stage A：报价转销售订单

Stage A 在一期单证工作台上增加报价与销售订单的双向来源关系，不依赖客户追踪链接的确认事件：

- `POST /api/document-sets/:id/sales-order` 接收 `order_number` 与 UUID `idempotency_key`，要求同时具备 `document_sets:manage` 和 `orders:create`，并按两项权限的数据范围收紧。
- 报价必须已关联有效客户；报价本身可以仍是草稿，也不要求客户打开、下载或确认任何导出。
- 首次转换创建草稿销售订单和行项目，固定保存报价 ID、报价号、源版本与完整内部快照。后续报价版本不会改写订单的来源快照。
- 同一报价只允许生成一个销售订单。原请求重复、网络重试或使用新请求键再次转换，均返回同一订单；同一请求键用于其他报价时返回冲突。
- 报价详情通过 `sales_order_id` 回链订单；销售订单列表和详情通过 `source_quote_id`、`source_quote_number`、`source_quote_version` 回链原报价。
- 完整来源快照只存储于数据库，不进入销售订单 API、Web 响应或审计详情；成本字段继续受 `document_financials:view` 保护。

迁移文件为 `054_kir_33_stage_a_quote_order_link.sql`。回滚会移除销售订单上的来源字段和约束，但不修改 053 已发布结构；执行前仍需按正常变更流程备份。
