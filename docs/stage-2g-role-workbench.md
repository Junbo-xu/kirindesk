# 阶段 2G：角色工作台与业务凭证链交付说明

## 结论

角色工作台、服务端有效权限清单、渲染前导航过滤、敏感页面水印、CSV 导出水印、业务凭证时间线投影，以及价差、数量差、费用缺失、重复客户四类异常的真实持久化闭环已经实现并通过定向自动化验证。

本交付不能宣称阶段 2G 全量完成：阶段 2B–2F 尚未实现 PI、收款、采购申请、到货/QC、发货、财务核对、利润、提成修订、样品和售后的业务凭证，因此当前时间线只能聚合阶段 2A 和既有订单/审计事实，以及新异常状态事件。只有前序阶段把对应领域事件接入后，才能满足“完整十二步、样品与售后全链凭证”的最终验收。

## 已完成范围

- `GET /api/auth/me` 返回服务端计算的有效权限及最宽数据范围；前端不解析 JWT 或自行推断角色。
- 角色工作台根据底层资源权限分别生成业务、采购、财务、审批和管理能力，以及实时待办、异常和经营摘要。
- 所有工作台汇总使用 PostgreSQL 聚合，金额保持 `numeric` 字符串；`own`、`assigned` 和 `all` 在查询前生效。
- 租户导航在渲染前按有效权限过滤；直达页面仍经过前端体验守卫，对应 API 继续由 `TenantAuthGuard`、`PermissionGuard`、数据范围条件和 RLS 保护。
- v1 占位首页和 17 项平铺顶栏已替换为角色工作台与分组侧栏；未获批准的 AI/OCR mock 不再出现在主导航。
- `business_events` 保存链根、凭证引用、事件类型、操作者、可见权限和范围锚点，不保存客户原文、供应商证据、金额明细或自由文本处理结论。
- 时间线同时投影允许列表内的既有审计摘要；`supplier_quotation` 完整证据明确排除，未知资源默认不可见。
- `business_events:view` 自身的数据范围会继续收窄底层资源权限，避免“底层资源为 all”绕过时间线的 own/assigned 范围。
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
- 认证、导出与 2G 定向集成：3 个文件、37 个用例通过。
- 2G 专项集成：6 个用例通过，覆盖五类角色工作台、无权限 403、跨租户 RLS、四类异常、状态机/CAS、assigned 时间线、供应商证据反向断言、事件不可变和审计链完整性。
- `pnpm exec playwright test apps/web/e2e/role-workbench.spec.ts`：Chromium 5 个角色场景全部通过。测试启动真实 NestJS API，使用真实登录、角色、用户和 PostgreSQL 数据，不拦截 `/api` 或使用浏览器 mock。
- `TEST_DATABASE_URL=... pnpm verify:migrations`：`045` 与 `044` 回滚后按原 checksum 前滚通过。
- `pnpm test:security`：19/19 通过。
- API 与 Web production build：通过。

## 迁移与回滚

`045_stage_2g_workbench_credentials.sql` 是加法迁移，新增 `business_exceptions` 和 `business_events`，不转换或删除既有业务数据。它依赖 `044` 提供的 `users(tenant_id, id)` 复合唯一约束，以建立租户复合外键。

迁移 DOWN 会先删除 `business_events`、不可变触发器，再删除 `business_exceptions`。回滚会永久删除已生成的异常、分派、处理结论和业务事件投影；如隔离环境已有验收数据，必须先备份新表并优先前滚修复。

代码回滚需要同时移除 `WorkbenchModule`、新增前端页面/导航守卫、`/auth/me` 权限字段和两类导出水印。若仅回滚前端而保留 API，新数据不会丢失；若仅回滚迁移而保留 API，应用启动后的工作台请求会失败，因此不可拆分执行。

## 风险与阻塞

- 阶段 2G 当前依赖尚在独立审核中的阶段 2A：`AuditService.logInTransaction` 和 `044` 复合租户约束尚未形成已批准基线。
- 阶段 2B–2F 未完成，时间线尚无 PI、收款、采购申请、履约、财务、利润、完整提成、样品和售后凭证；这些缺口不能用通用审计事件或手工插入冒充。
- 当前共享工作树位于 `feat/kir-6-stage-2a`，且包含另一交付的未提交文件。为避免把未审核的 2A 与 2G 混成一个提交，本轮没有提交、推送或创建 PR。
- 前序阶段通过后，应在干净的 2G 特性分支重放本增量，执行完整质量门禁，再交由 Kai 独立审核。
