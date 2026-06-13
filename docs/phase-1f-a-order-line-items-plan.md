# Phase 1F-A 实施规划:订单明细行(Order Line Items)

状态:规划提案,待确认。本文件不含代码、不建 migration、不提交。

适用范围:为销售订单(sales_orders)与采购订单(purchase_orders)补充明细行,
打通后续 finance / reports / 提成 / 审批 的数据基础。本阶段聚焦"行项 + 总额来源",
不引入审批流、不引入多币种折算。

---

## 1. 表结构:sales_order_items / purchase_order_items

两张结构对称的表(销售一张、采购一张),字段一致,仅外键指向不同的订单头表。
金额一律用 `decimal`,绝不用 float(避免精度丢失)。

### sales_order_items

| 字段 | 类型 | 约束 / 说明 |
|------|------|------------|
| id | uuid | PK,default uuid_generate_v4() |
| tenant_id | uuid | NOT NULL,REFERENCES tenants(id);冗余存放以支撑 RLS(见 §2) |
| order_id | uuid | NOT NULL,REFERENCES sales_orders(id) ON DELETE CASCADE;行随单走 |
| line_no | integer | NOT NULL,行序号(租户内+单内唯一,见索引);CHECK line_no > 0 |
| description | varchar(500) | NOT NULL,品名 / 描述;MinLength 1 |
| product_code | varchar(64) | NULL,可选货号 / SKU |
| unit | varchar(16) | NULL,单位(pcs / kg / ctn 等) |
| quantity | decimal(18,3) | NOT NULL,CHECK quantity > 0;允许小数(按重量 / 长度计价) |
| unit_price | decimal(18,4) | NOT NULL,CHECK unit_price >= 0;单价精度高于金额(避免乘积累计误差) |
| line_total | decimal(18,2) | NOT NULL,CHECK line_total >= 0;= round(quantity * unit_price, 2),服务端计算 |
| notes | varchar(1000) | NULL,行备注 |
| created_at | timestamptz | NOT NULL DEFAULT now() |
| updated_at | timestamptz | NOT NULL DEFAULT now() |
| deleted_at | timestamptz | NULL,软删标记(见 §5) |

purchase_order_items 与上表完全一致,仅 `order_id REFERENCES purchase_orders(id) ON DELETE CASCADE`。

精度说明(对抗式自检后的取舍):
- `quantity decimal(18,3)`:外贸常见按重量/长度,3 位小数够用。
- `unit_price decimal(18,4)`:单价比金额多 2 位精度,先乘后 round 到分,减少累计误差。
- `line_total decimal(18,2)`:与订单头 `total_amount numeric(18,2)` 同精度,便于汇总比对。
- 提案曾考虑金额用 decimal(12,2),但订单头已是 numeric(18,2);为与既有 total_amount
  保持一致、避免汇总溢出/精度不匹配,明细行金额统一采用 18 位整数精度,**不降为 12**。

tenant_id 用法:虽然 order_id 已能间接定位租户,但 order_items **直接冗余 tenant_id**,
原因:① 让 RLS 策略可直接 `tenant_id = app_current_tenant_id()`,无需 JOIN 订单头;
② 与项目既有所有业务表(customers / sales_orders / ...)的隔离模式一致;
③ 写入时由服务端从订单头取 tenant_id 回填,客户端不可指定。
一致性由 FK + 写路径保证(插入行项前先在同一事务校验订单头属于当前租户)。

---

## 2. RLS 策略

完全沿用既有业务表(027 purchase_orders)的 FORCE RLS + 单一隔离策略模式,
两张明细表各自独立启用。每张表:

```sql
ALTER TABLE sales_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON sales_order_items
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON sales_order_items TO kirindesk_app;
```

purchase_order_items 同上(仅表名替换)。

要点与取舍:
- `FORCE ROW LEVEL SECURITY`:对表 owner 也强制策略,与 021/027 一致,防止迁移/后台连接
  绕过隔离。
- 策略直接作用于本表冗余的 `tenant_id`(见 §1),**不 JOIN 订单头** —— 这正是冗余
  tenant_id 的目的:RLS 判定零 JOIN、与既有表行为一致。
- `FOR ALL`(SELECT/INSERT/UPDATE/DELETE 统一)+ `WITH CHECK`:写入时也校验
  tenant_id 必须等于当前上下文,杜绝跨租户插行。
- 不授予 `kirindesk_app` 任何 BYPASSRLS;app role 已确认无超级权限(见 Phase 1E 自查)。
- 双重保险:除 RLS 外,写路径仍在同一事务内先校验订单头属于当前租户、再回填 tenant_id
  到行项(见 §8),应用层与数据库层各拦一道。

## 3. 索引

参照 sales_orders / purchase_orders 既有索引命名与组合(均以 tenant_id 打头,贴合 RLS
与租户内查询)。每张明细表:

| 索引 | 列 | 用途 |
|------|-----|------|
| PK | (id) | 主键 |
| idx_<t>_items_tenant_id | (tenant_id) | RLS / 租户级扫描的基础,与既有表一致 |
| idx_<t>_items_tenant_order | (tenant_id, order_id) | 最热路径:按订单加载其所有行项 |
| uq_<t>_items_order_line_no | UNIQUE (tenant_id, order_id, line_no) WHERE deleted_at IS NULL | 单内行序号唯一;部分索引使软删行不占用号 |
| idx_<t>_items_deleted_at | (deleted_at) | 软删过滤,与既有表 idx_*_deleted_at 一致 |

(`<t>` = sales_order / purchase_order)

要点与取舍:
- `(tenant_id, order_id)` 是行项最高频访问模式(详情页/编辑页加载某单全部行),单列
  order_id 索引无必要(tenant_id 前缀已足够选择性且复用 RLS 路径)。
- 行序号唯一约束用**部分唯一索引** `WHERE deleted_at IS NULL`:软删一行后,其 line_no
  可被新行复用,避免"删了还占号"。这是行项软删(§5)与 line_no 唯一性共存的关键。
- 暂不为 product_code 建索引:本阶段无"按货号搜行项"的需求,YAGNI,后续报表阶段如需再加。
- 不重复为 order_id 单独建非复合索引:ON DELETE CASCADE 的级联删除走 FK,
  Postgres 对 CASCADE 不强制要求子表索引,而 (tenant_id, order_id) 已覆盖按单查询。
  (注:若后续压测显示级联删除慢,再评估补 (order_id) 单列索引。)

## 4. 软删策略

行项采用**软删**(`deleted_at` 标记),与全项目既有业务表一致,不做物理 DELETE。

行项自身的删除(编辑订单时移除某一行):
- 设 `deleted_at = now()`,行保留在表中,默认查询/汇总均带 `deleted_at IS NULL` 过滤。
- 与 §3 的部分唯一索引 `(tenant_id, order_id, line_no) WHERE deleted_at IS NULL` 配合:
  软删后该 line_no 立即可被新行复用,不会因"号被占"而冲突。
- total_amount 重算只累加未软删行(`deleted_at IS NULL`),所以删行后总额自动减少(§6 派生)。
- 保留软删行的价值:审计可追溯"这单曾经有过哪几行、何时删的",支撑后续利润/提成回溯。

订单头软删时(删整单):
- 订单头 `sales_orders.deleted_at = now()`,**行项不联动改动**(不批量打软删标记)。
- 行项的 `ON DELETE CASCADE` 仅在订单头被**物理删除**时触发;软删不是物理删除,故不触发级联,
  行项原样保留。这是有意设计:整单软删后若需恢复,行项数据完好可一并恢复。
- 列表/详情读取已软删订单时,本就被订单层的 `deleted_at IS NULL` 拦截,行项不会被读到,
  无需额外清理。
- CASCADE 仅作为"万一订单头被硬删(如未来的合规清除/GDPR 删除)时不留孤儿行"的兜底。

取舍小结(对抗式自检):
- 为何不在整单软删时也给行项打 deleted_at?——多余写放大、且破坏"整单恢复"语义;
  读路径已被订单层过滤拦住,行项软删标记对整单删除场景无增益。
- 为何不用硬删行项?——与项目软删惯例不一致,且丢失审计可追溯性,违背 §5 目标。

## 5. 审计

行项变更**并入订单头的审计事件**,不为行项单独开 `*_item.*` 事件类型。

设计:
- 订单的 `create` / `update` 仍记 `sales_order.created` / `sales_order.updated`
  (采购同理),其审计 payload 的 `before` / `after` **包含完整行项快照**(行数组),
  因此行项的增、删、改都体现在订单 updated 事件的 before→after 差异中。
- 行项快照随订单头一起进入 append-only 哈希链(复用既有 AuditService.log + safeAudit),
  不新增链结构。
- resource_type 仍为 `sales_order` / `purchase_order`;resource_id 为订单头 id。

理由(对抗式自检):
1. 行项无独立生命周期 —— 它永远从属于某张订单,脱离订单头无意义。审计的语义单位是
   "这张订单发生了什么变化",行项是该变化的一部分,合并记录更贴合业务追溯。
2. 单一事件含 before/after 全行快照,即可还原"哪一行的单价从 X 改成 Y、删了哪一行",
   信息完整,无需拆成多条 item 事件。
3. 避免事件风暴:一次编辑改 5 行不应产生 5 条独立审计 + 1 条订单审计;一条订单 updated
   足矣。
4. 与既有订单审计(1B/1D)无缝衔接,不破坏现有 verifyChain 测试。

注意点:
- `total_amount` 的派生变化(§6)天然包含在订单头 before/after 中,无需额外记录。
- 行项快照需脱敏一致性:沿用 toResponse 风格的 allowlist(不泄露内部列),与文件/订单
  既有审计 payload 处理方式保持一致。

## 6. total_amount 设计决策:派生 vs 可手填

### 选项

- 选项 A「严格派生」:`total_amount` = 所有未软删行项 `line_total` 之和,服务端在每次
  行项增删改后重算并写回订单头。客户端**不可**直接设置 total_amount。
- 选项 B「可手填 + 校验」:客户端可传 total_amount,服务端校验其等于行项汇总,不等则报错。
- 选项 C「可手填,行项可选」:total_amount 始终以客户端为准,行项纯附加信息,不强制一致。

### 推荐:选项 A「严格派生」(对新建订单),并对历史订单做兼容(见 §7 回填)

理由:
1. 单一事实来源:总额由行项唯一决定,杜绝"头尾对不上"的脏数据,这是 finance / 提成
   下游能信任数据的前提。
2. 防篡改:total_amount 不再由客户端控制,符合 CLAUDE.md「敏感动作服务端控制」。
3. 选项 B 看似灵活,实则把"算错"的责任推给客户端,且需要前后端两套相同算法,易漂移。
4. 选项 C 放弃一致性,与本阶段「为财务打基础」的目标冲突。

派生方案下的取舍(对抗式自检):
- 新建订单是否强制至少一行?推荐**强制 ≥ 1 行**(草稿 draft 状态可放宽为允许 0 行,
  便于先存草稿再补行项)。最终规则在 §7 与验收标准中固化。
- 历史订单(1B/1D 已产生、无行项、total_amount 手填)如何兼容?见 §7。
- total_amount 列保留还是删除?**保留**(作为派生缓存,便于列表页排序/筛选不必每次聚合),
  但写路径改为服务端派生,DTO 移除该字段的客户端入参。

## 7. 既有订单回填 / 兼容方案

历史订单(1B/1D 已产生,无行项,total_amount 为手填值)必须继续可读、可用。

兼容规则:
- **不为历史单生成占位行项**。迁移只建表,不回填数据 —— 凭空造行会污染审计与利润核算
  (无法知道真实品名/单价)。历史单维持"有 total_amount、零行项"的状态。
- `total_amount` 列**保留**,语义从"手填值"演变为"派生缓存":
  - 历史单:沿用既有手填值,展示不变。
  - 新建/编辑单:由服务端按行项汇总写回(§6 选项 A)。
- 读路径统一:列表/详情直接读 `total_amount` 列(不实时聚合),历史单与新单一视同仁,
  排序/筛选行为不变。
- 行项可选性规则:
  - `draft` 状态:允许 0 行(先存草稿,后补行项)。
  - 非 draft(confirmed/completed):若该单**有**行项,total_amount 必须等于汇总;
    若该单**无**行项(典型为历史单),允许保留既有 total_amount,不强制补行。
  - 即:新数据走严格派生,旧数据宽容放行 —— 不因引入行项而使历史单变为非法。
- 编辑历史单时:一旦用户为历史单添加第一行,该单即切换为"派生"模式,total_amount
  改由行项汇总接管(并在审计 before/after 中留痕)。

## 8. 对 1B / 1D 既有写路径的改动范围与回归测试

代码改动范围(api,sales-orders 与 purchase-orders 对称):
- 新增 `*_order_items` 的 service / repository 逻辑、DTO(行项数组:description、
  product_code、unit、quantity、unit_price、notes;line_no 由服务端分配)。
- `create`:在既有事务内,插入订单头后批量插入行项、服务端计算每行 line_total 与
  汇总 total_amount 写回头部。整个操作维持单事务(失败全回滚)。
- `update`:在事务内做行项的 diff(增/改/软删)、重算 total_amount;沿用既有
  fetchInScope + 白名单列模式。
- DTO 改动:create/update DTO **移除客户端 `total_amount` 入参**(改为派生),
  新增可选 `items` 数组及其校验(quantity>0、unit_price≥0、money 正则)。
- response:订单详情 toResponse 增加 `items` 字段;列表可不含行项(保持轻量)。
- 前端:订单表单加行项编辑器(增删行、自动算小计/总额,只读展示 total_amount)。

回归测试覆盖点(在既有 sales-orders / purchase-orders 集成测试上扩展):
- 既有用例:create/list/getOne/update/soft-delete + 400/401/404/409 必须仍全绿
  (DTO 去掉 total_amount 后,相关用例需同步调整为不再传该字段)。
- 新增用例:
  - 创建带 N 行的订单 → total_amount = Σ line_total,行项正确返回。
  - 编辑:增行/改单价/软删行 → total_amount 同步重算;line_no 复用正确。
  - draft 允许 0 行;非 draft 有行项时总额一致性校验。
  - 历史单(无行项)仍可读、可编辑、加首行后切换派生。
  - RLS:跨租户读/写行项被隔离(复用既有跨租户用例模式)。
  - 行项软删后不计入汇总、不被默认查询返回。
  - 审计:订单 updated 事件 before/after 含行项快照,verifyChain 仍通过。
  - 事务性:行项插入失败时订单头一并回滚(无半写)。

## 9. Rollback(down 迁移)

数据库回退:
```sql
-- DOWN
DROP TABLE IF EXISTS sales_order_items CASCADE;
DROP TABLE IF EXISTS purchase_order_items CASCADE;
```
- 两张表均为本阶段新建,DROP 即完全回退;`CASCADE` 清理随表的索引/策略/约束。
- 订单头表(sales_orders/purchase_orders)**不被迁移改动结构**(total_amount 列在
  Phase 1B/1D 已存在),故 down 迁移无需触碰订单头,历史数据零风险。

代码层回退:
- total_amount 由"派生"改回"客户端手填"属于应用层行为,随代码版本回滚即可恢复;
  数据库层无强制约束绑定派生逻辑(total_amount 仍是普通列),故 DB 与代码可独立回退。
- 回退后已写入的行项数据随表 DROP 一并消失;若需保数据,改为仅回退代码、保留空表。

## 10. 验证命令

```bash
# 迁移往返(应用 → 回退 → 再应用,验证 up/down 对称、可重入)
pnpm db:migrate
pnpm db:rollback        # 执行 down,确认两表被 DROP
pnpm db:migrate         # 重新应用

# 全量质量门禁(lint / format / typecheck / build / unit / integration / security)
pnpm verify

# 仅跑订单相关集成测试(快速回归)
pnpm --filter @kirindesk/api test:integration sales-orders
pnpm --filter @kirindesk/api test:integration purchase-orders

# 结构核查(行项表的 RLS / 索引 / 约束就位)
docker exec kirindesk-postgres-1 psql -U kirindesk -d kirindesk_dev -c "\d sales_order_items"
docker exec kirindesk-postgres-1 psql -U kirindesk -d kirindesk_dev -c "\d purchase_order_items"
```
端到端(可选,手动):创建带行项订单 → 校验 total_amount 汇总 → 编辑增删行 → 重算正确
→ 历史单仍可读 → 跨租户隔离 → 审计链 verifyChain 通过。

## 11. 验收标准

- [ ] 两张明细表(sales_order_items / purchase_order_items)建成,字段/类型/精度同 §1。
- [ ] 每张表 FORCE RLS + tenant_isolation_policy 生效;跨租户读/写被拦截(集成测试证明)。
- [ ] 索引与部分唯一约束(§3)就位;软删行的 line_no 可复用。
- [ ] 创建带行项订单:total_amount 由服务端按 Σ line_total 派生,客户端无法直接设定。
- [ ] 编辑订单:增行/改行/软删行后 total_amount 正确重算;操作维持单事务、失败全回滚。
- [ ] draft 允许 0 行;非 draft 有行项时强制总额一致。
- [ ] 历史无行项订单仍可读、可编辑;加首行后平滑切换为派生模式。
- [ ] 行项变更并入订单头审计事件,before/after 含行项快照;verifyChain 通过。
- [ ] 既有 1B/1D 集成测试调整后全绿;新增行项用例全绿。
- [ ] 全量 `pnpm verify` 绿(含 security 13/13);迁移 up/down 往返成功。
- [ ] 前端订单表单可增删行、自动算小计与总额,total_amount 为只读派生展示。
