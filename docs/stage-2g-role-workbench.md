# 阶段 2G：角色工作台与业务凭证链交付说明

## 结论

角色工作台、服务端有效权限清单、渲染前导航过滤、敏感页面水印、CSV 导出水印、业务凭证时间线投影，以及价差、数量差、费用缺失、重复客户四类异常的真实持久化闭环已经实现并通过定向自动化验证。

当前基线已包含阶段 2B–2F。PI、收款、采购申请/采购单、到货/QC、发货、费用、财务核对、利润、提成修订、样品和售后领域服务均在各自事务中追加最小业务事件。时间线把每条可见业务事件的“链根 -> 凭证”引用作为双向边递归解析，因此可从询盘、销售订单、采购订单、业务异常、样品单或样品转成后的订单聚合前后凭证。每条用于扩链的边和最终返回事件都必须先通过当前用户的底层资源权限及 `business_events:view` 数据范围；知道 UUID 不构成读取授权。

## 已完成范围

- `GET /api/auth/me` 返回服务端计算的有效权限及最宽数据范围；前端不解析 JWT 或自行推断角色。
- 角色工作台根据底层资源权限分别生成业务、采购、财务、审批和管理能力，以及实时待办、异常和经营摘要。
- 所有工作台汇总使用 PostgreSQL 聚合，金额保持 `numeric` 字符串；`own`、`assigned` 和 `all` 在查询前生效。
- 租户导航在渲染前按有效权限过滤；直达页面仍经过前端体验守卫，对应 API 继续由 `TenantAuthGuard`、`PermissionGuard`、数据范围条件和 RLS 保护。
- v1 占位首页和 17 项平铺顶栏已替换为角色工作台与分组侧栏；未获批准的 AI/OCR mock 不再出现在主导航。
- `business_events` 保存链根、凭证引用、事件类型、操作者、可见权限和范围锚点，不保存客户原文、供应商证据、金额明细或自由文本处理结论。
- 时间线同时投影允许列表内的既有审计摘要；`supplier_quotation` 完整证据明确排除，未知资源默认不可见。
- `business_events:view` 自身的数据范围会继续收窄底层资源权限，避免“底层资源为 all”绕过时间线的 own/assigned 范围。
- 指定链根时，服务端使用 `WITH RECURSIVE` 遍历当前用户可见的不可变业务事件边；无权事件不会成为连接上下游的隐式权限桥。
- 样品转订单事务显式追加 `sample_order -> generated inquiry -> sales_order` 两条最小关系事件，不依赖响应正文、转换快照或关系表推断授权。
- 阶段 2B–2F 的领域事件只保存凭证类型、凭证 ID、事件类型、操作者和时间，PI 内容、收付款金额、供应商证据、物流说明、利润输入及售后原因仍保留在各自受保护资源中。
- `business_exceptions` 覆盖 `price_variance`、`quantity_variance`、`missing_expense`、`duplicate_customer`，支持 `open -> assigned -> in_progress -> resolved -> closed`。
- 异常分派、开始处理、处理完成和关闭均由服务端状态机与 `expectedVersion` CAS 控制，并在同一租户事务中追加 hash-chain 审计和不可变业务事件。
- 新表均带 `tenant_id`、租户复合外键、`ENABLE/FORCE RLS` 和最小应用角色权限；业务事件禁止更新和删除。
- 报表与审计 CSV 固定写入租户 ID、导出人 ID、UTC 导出时间和授权转发提示；敏感租户页面显示当前用户、租户和渲染时间水印。

## 端点与页面

新增服务端端点：

- `GET /api/workbench`
- `GET /api/business-events`
- `GET /api/business-exceptions`
- `GET /api/business-exceptions/assignees`
- `GET /api/business-exceptions/:id`
- `POST /api/business-exceptions/:id/assign`
- `POST /api/business-exceptions/:id/start`
- `POST /api/business-exceptions/:id/resolve`
- `POST /api/business-exceptions/:id/close`

新增或重构租户页面：

- `/`：角色工作台
- `/inquiries`：业务询盘待办
- `/quote-tasks`：采购脱敏报价任务
- `/exceptions`：异常分派、处理和关闭
- `/timeline`：凭证时间线
- 其余既有页面改为权限分组导航和逐路由体验守卫

## 自动化证据

- `pnpm --filter @kirindesk/api typecheck`：通过。
- `pnpm --filter @kirindesk/web typecheck`：通过。
- `pnpm --filter @kirindesk/api lint`：通过。
- `pnpm --filter @kirindesk/web lint`：通过。
- `pnpm --filter @kirindesk/api test:unit`：12 个文件、62 个用例通过，含报表/审计导出水印断言。
- API 完整集成回归：26 个文件、413 个用例全部通过。
- 2G 专项集成：8 个用例通过，覆盖五类角色工作台、无权限 403、跨租户 RLS、四类异常、状态机/CAS、assigned 时间线、正反向多跳链、无权边阻断、供应商证据反向断言、事件不可变和审计链完整性。
- 真实领域回归：2C 采购服务生成 `sales_order -> purchase_order -> business_exception` 后，可从订单或异常双向聚合；2F 样品服务生成 `sample_order -> generated inquiry -> sales_order` 后，可从样品单或销售订单双向聚合。两组响应均反向断言不含供应商改价原因、客户原文、收件信息、付款条款或供应商证据。
- `pnpm exec playwright test apps/web/e2e/role-workbench.spec.ts --project=chromium`：5/5，通过业务、采购、财务、审批人和管理员真实浏览器路径。测试启动真实 NestJS API，使用真实登录、角色、用户和 PostgreSQL 数据，不拦截 `/api` 或使用浏览器 mock。
- `TEST_DATABASE_URL=... pnpm verify:migrations`：`045` 与 `044` 回滚后按原 checksum 前滚通过。
- `pnpm test:security`：19/19 通过。
- API 与 Web production build：通过。

## 迁移与回滚

`045_stage_2g_workbench_credentials.sql` 是加法迁移，新增 `business_exceptions` 和 `business_events`，不转换或删除既有业务数据。它依赖 `044` 提供的 `users(tenant_id, id)` 复合唯一约束，以建立租户复合外键。

迁移 DOWN 会先删除 `business_events`、不可变触发器，再删除 `business_exceptions`。回滚会永久删除已生成的异常、分派、处理结论和业务事件投影；如隔离环境已有验收数据，必须先备份新表并优先前滚修复。

代码回滚需要同时移除 `WorkbenchModule`、新增前端页面/导航守卫、`/auth/me` 权限字段和两类导出水印。若仅回滚前端而保留 API，新数据不会丢失；若仅回滚迁移而保留 API，应用启动后的工作台请求会失败，因此不可拆分执行。

本次审核整改没有数据库迁移或历史数据改写。单独回退本次代码提交会恢复未逐边鉴权的关系表扩链，并停止为新样品转换追加显式关系事件；已有 `business_events` 不会被删除，但多跳查询和权限桥回归会再次失效。

## 风险与后续约束

- 时间线是最小凭证索引，不是敏感证据副本；查看金额、原文、附件或处理原因仍必须进入对应受保护资源。
- 新增业务域如果引入新的链根类型，必须在同一领域事务中追加最小关系事件；缺失事件不会用关系表或敏感正文自动推断，历史回填需在阶段 3 单独设计和演练。
- 递归范围随当前租户、当前用户可见的连通事件图增长。RLS、逐边权限/范围过滤和现有链根/凭证索引限制扫描边界；阶段 3 仍需记录大租户数据量下的查询计划与时延基线。
- 后续修改事件图必须保留跨租户、底层权限、`own`/`assigned` 范围、未知链类型和敏感正文反向测试。
