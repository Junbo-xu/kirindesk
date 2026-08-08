# KIR-26 migration checksum drift 修复证据

- 日期：2026-08-05
- 分支：`fix/kir-26-migration-checksum-drift`
- 基线：`origin/main` @ `a2f00dff8f24b86dad71ac27c97976b6f8107c3b`
- 边界：仅使用隔离的 `kirindesk_test` 与 loopback 测试设施；未读写生产数据、凭据或环境

## 1. 结论与验收

`051_kir_21_p0_web_remediation.sql` 已恢复为 staging 首次应用的不可变内容，SHA-256 为 `4e697e314712a1796550ef7cf8a6852a75ef1d7296cf489b0ab9f0d5b4fd0992`。后续角色授权回填已迁移到新的 `052_backfill_inquiries_update_role_grants.sql`。

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 恢复已发布 `051` | 通过 | 文件 checksum 与旧 staging ledger 一致；新单测固定该 checksum，防止再次 drift |
| 新建库从零迁移 | 通过 | API 集成 setup 重建 `kirindesk_test` 并应用 `000`–`052`，26 files / 416 tests 通过 |
| 旧 `051` 环境前滚 | 通过 | 演练回滚到已应用 `051`，再由正式 migrator 应用 `052`；`051` 及更早 ledger 的 id/checksum/applied_at/execution_ms 逐行不变 |
| 自定义角色授权 | 通过 | 预置 `inquiries:update=own` 保持不变；缺失授权按 `create=all + submit=assigned` 回填为最窄 `assigned` |
| 迁移/发布/回滚演练 | 通过 | `verify:migrations` 与 `verify:release-data` 均通过，影子库最终迁移为 `052` |

## 2. 实现证据

- `db/migrations/051_kir_21_p0_web_remediation.sql`：删除后加的授权回填，字节级恢复已发布版本。
- `db/migrations/052_backfill_inquiries_update_role_grants.sql`：对同时拥有 `inquiries:create` 和 `inquiries:submit` 的角色幂等补入 `inquiries:update`；取两项授权中更窄的 data scope，`ON CONFLICT DO NOTHING` 保留租户已有决策。
- `packages/database/src/rehearse.ts`：在既有最近两份 DOWN/UP 演练后，新增旧 `051` ledger、自定义角色与授权前后断言；演练 fixture 在单一事务中创建并在验证后清理。
- `packages/database/src/published-migration-checksum.test.ts`：把已发布 `051` checksum 纳入 unit gate。
- `packages/database/src/release-rehearsal.ts`：将 release candidate 终点从 `051` 推进到 `052`。

## 3. 自动化结果

| 命令 | 结果 |
| --- | --- |
| `pnpm verify:fast` | 通过；全仓 lint / format / typecheck / build / 113 unit tests / production dependency audit 全绿 |
| `pnpm test:integration` | 26 files / 416 tests 通过；从零应用全部迁移 |
| `pnpm verify:migrations` | `052` DOWN、`051` DOWN、`051` UP、`052` UP 通过；旧 `051` 再前滚 `052` 通过 |
| `pnpm verify:release-data` | PASS；影子库 `049` → `052`，76 张基线表 / 408 行数据保持，候选共 90 表，0 orphan，备份恢复对账一致 |
| `git diff --check` | 通过 |

`verify:migrations` 结束后复核表明：`051` ledger 仍为发布 checksum，`052` 已应用，演练租户残留为 0，release shadow/restore 临时库残留为 0。

## 4. 迁移影响与回滚

### 前滚

- 无 DDL、无表重写、无金额或业务记录转换。
- 新建环境依次应用不变的 `051` 和新 `052`。
- 已应用 `051` 的环境校验和一致后只应用 `052`，不修改 `_migrations` 历史。
- 仅缺失 `inquiries:update` 的候选角色会新增一行 `role_permissions`；已有授权不被改写。

### 回滚

1. 先回滚 API/Web 到上一个已审核版本。
2. 如需回退迁移终点，执行一次 `pnpm db:rollback`；`052` DOWN 有意为非破坏性 no-op，只移除 `052` ledger，保留所有租户授权。
3. 重新前滚时 `052` 通过幂等插入恢复 ledger，不改写既有授权。
4. `051` 是已发布基线，不应作为 KIR-26 回滚的一部分；若另行回退到 `050`，其既有 DOWN 会删除 `inquiries:update` 及相关授权，必须作为独立的停机/数据保护决策审核。

## 5. 风险与发布边界

- `052` 只给同时具有 create/submit 的角色回填 update；仅持有其中一项的角色不会被自动扩权。
- 既有 `inquiries:update` 授权即使比推导范围更宽也不会被改写；这是保留租户自定义 RBAC 的明确边界，不代替租户管理员的权限复核。
- 生产依赖审计仍有一项已登记、未过期的 `react-router` 高危例外；本修复未引入或更改任何依赖。
- 本证据是开发自检，不是 Kai 的独立审核结论，不授权合并 `main` 或生产发布。
- 本修复不解除 KIR-18 的 NO-GO。
