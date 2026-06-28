# Phase 3 规划 — 私有化部署支持（Private-Deployment-Ready）

> 本文件为**规划文档**。按 CLAUDE.md §1，输出后停下等待确认，不在确认前实施。
> Phase 3 范围较大，按 §2「最简先行、增量推进」拆分为 3A/3B/3C/3D 子阶段。
> **本期只做 Phase 3A**；3B/3C/3D 列出范围但本期不实施，留待后续单独规划确认。

---

## 0. 背景与定位

KirinDesk 从第 0 阶段起即按「private-deployment-ready」（可私有化部署）设计
（CLAUDE.md §3 对外措辞、§7 provider 抽象、§4 多租户隔离）。当前代码已具备：

- provider 全部走接口 + `*_PROVIDER` 工厂，未硬连真实厂商（AI/OCR/支付/通知/存储均 mock 或可换）。
- 运行时强制使用非超级用户 `APP_DATABASE_URL`（`kirindesk_app`），启动自检拒绝超管角色。
- JWT 双密钥 `requireEnv` 失败即拒启动，无可猜默认值（Phase 0I-A）。
- 审计 append-only（权限 + 触发器双层）。
- `docs/security-hardening-plan.md` 已沉淀「上线前必须项 / 部署安全清单」。

**但目前没有「把整套系统打包成可在客户内网一键拉起」的产物**：无 Dockerfile、无生产
compose、无统一健康检查、无部署文档。应用仍靠 `pnpm dev` 起。Phase 3 补齐这一层。

> Phase 3 是**部署形态 / 打包 / 配置外置**的工程，不是新业务功能。绝大部分工作是
> 新增文件与配置，对现有业务代码改动极小、对数据库**本期零变更**。

---

## 1. 范围说明（本期做 / 推后）

### 1.1 本期做（Phase 3A —「可在单机内网用 docker compose 拉起整套系统」）

目标：一台装了 Docker 的内网主机，`cp .env.production.example .env.production` 填好密钥后，
`docker compose -f docker-compose.prod.yml up -d` 即可拉起 **API + Web + Postgres + Redis +
MinIO + 反向代理**，迁移自动执行，浏览器访问反代端口即可登录使用。

本期交付物：

1. **应用镜像 Dockerfile**
   - `apps/api`：多阶段构建（pnpm 安装 → `nest build` → 运行期 `node dist/main`）。
   - `apps/web`：多阶段构建（`vite build` → 静态产物交给 nginx）。
   - `apps/admin`：暂**不**打镜像（见 §1.2，admin 当前近乎空壳）。
2. **迁移执行形态**：生产镜像内可执行 `pnpm db:migrate`（用超管 `DATABASE_URL`，
   一次性 init 容器 / 手动步骤），与运行期容器（只拿 `APP_DATABASE_URL`）分离 —— 落实
   security-hardening-plan「app 容器永不注入超管」要求。
3. **生产 compose**：`docker-compose.prod.yml`，全部 env 驱动、默认不对公网暴露 DB/Redis/MinIO
   端口，仅暴露反向代理端口。
4. **反向代理**：`docker/nginx/` 配置，同源服务 Web 静态 + 把 `/api` 反代到 API 容器 ——
   让现有「相对 `/api` 路径」的前端 client 在生产同源工作（无需改前端）。
5. **健康检查端点**：`GET /healthz`（liveness，纯存活）、`GET /readyz`（readiness，
   做一次 `SELECT 1` 探活 DB）。**无鉴权、无租户数据**，仅用于容器编排探针。
6. **配置外置/容器安全加固（仅代码层面，非 schema）**：
   - `main.ts` / `client.ts` 的 `.env` 加载改为「文件存在才加载、且不覆盖已注入的
     `process.env`」，使容器注入环境变量为唯一事实源。
   - bootstrap 增加可选 CORS 白名单（`CORS_ORIGINS`，逗号分隔；未设则不开放跨域）。
   - 新增启动期必需环境变量校验汇总（缺失即 fail-fast，错误信息列出缺哪些）。
7. **环境样例与文档**：`.env.production.example`（安全占位符）、
   `docs/phase-3a-private-deployment-plan.md`（本文件落地后续状态）、README 增「私有化部署」节。

### 1.2 推后（明确不在本期）

| 子阶段 | 内容 | 推后理由 |
|---|---|---|
| **3B** | 平台管理员 bootstrap CLI（`pnpm admin:create`）；app-role 密码外置 / 运行-迁移-属主三角色分离的新迁移；对接外部 secret 管理 | 涉及新迁移 + 角色策略，需单独按 §5 规划；README 已声称「CLI 创建平台管理员」但 CLI 未实现，单独补 |
| **3C** | 备份/恢复脚本 + 演练（pg_dump/恢复、MinIO 桶导出）；MinIO 桶自动创建；TLS 终止指引 | security-hardening-plan 已列为「上线前必须项」，属运维流程，独立交付更清晰 |
| **3D** | 用外部 S3/对象存储替代自带 MinIO；集中日志/可观测性；离线/气隙安装包（镜像离线导入） | 取决于客户环境差异，过早做属 §2 「premature architecture」 |
| — | admin 应用打镜像 | `apps/admin` 当前仅骨架，无实质页面，打镜像无意义；待 admin 有内容再纳入 |
| — | k8s/helm chart、多副本、自动扩缩 | 私有化首期目标是单机 compose；编排是后续商业化议题 |

### 1.3 明确不改动的东西（安全边界，遵 §4）

- 不改任何 RLS 策略、不改租户隔离逻辑、不改审计写入/哈希链。
- 不改 provider 接口语义、不接任何真实厂商（AI/OCR/支付/通知/存储维持 mock，
  换真实厂商是后续「经批准的代码改动」，绝非配置 fallback —— 维持 §7）。
- 不动 `.claude/`，不提交 `.env`、真实密钥、`node_modules`、`dist`（§8）。

---

## 2. 数据库变更

**Phase 3A：无数据库变更（no migration、no schema change、no seed change）。**

- `/readyz` 只执行只读 `SELECT 1`，不建表、不写数据。
- app-role 密码外置、角色分离会动到迁移 / 角色策略，**已划入 3B**，本期不碰 ——
  因此本期对 `db/` 目录零改动，回滚成本最低。
- 现有迁移 `000_app_role.sql` 的硬编码密码问题在本期**仅以文档说明 + 部署步骤规避**
  （生产由运维在 init 阶段用真实密码创建/改密 `kirindesk_app`），代码层修复留 3B。

> 备注：按 §5「不在确认前创建/变更 schema」。本期既然零 schema 变更，§5 的表清单/RLS/索引/
> 软删/审计/回滚六项说明对本期不适用；待 3B 真正引入迁移时再单独走 §5 完整流程。

---

## 3. 文件清单（Phase 3A）

> 约定：✅=新增，✏️=修改。本期**不删除**任何文件。

### 3.1 应用镜像与编排（新增）

- ✅ `apps/api/Dockerfile` —— 多阶段：`base`(pnpm) → `build`(`nest build`) →
  `runtime`(精简 node，仅 `dist` + 生产依赖，`CMD ["node","dist/main"]`，非 root 用户)。
- ✅ `apps/web/Dockerfile` —— 多阶段：`build`(`vite build`) → `runtime`(nginx 托管静态产物)。
- ✅ `docker-compose.prod.yml` —— 服务：`api` / `web` / `postgres` / `redis` / `minio` /
  `proxy`(nginx) / `migrate`(一次性 init 容器，跑 `pnpm db:migrate` 后退出)。全 env 驱动；
  仅 `proxy` 暴露宿主端口；DB/Redis/MinIO 仅在内部网络互通。
- ✅ `docker/nginx/nginx.conf` —— 同源托管 Web 静态 + `location /api { proxy_pass api:3001; }`，
  传 `X-Forwarded-For`（配合后端 `TRUST_PROXY`，让限流 IP 取值正确）。
- ✅ `.dockerignore`（仓库根 + 各 app）—— 排除 `node_modules`/`dist`/`.env`/`.git`/`.claude`。

### 3.2 后端代码（修改，最小侵入）

- ✏️ `apps/api/src/main.ts` —— ①`.env` 改为「存在才加载、不覆盖已注入 env」；
  ②加可选 CORS（读 `CORS_ENABLED`/`CORS_ORIGINS`）；③`app.listen(port, '0.0.0.0')` 显式绑定；
  ④调用新增的启动期 env 校验。
- ✅ `apps/api/src/health/health.controller.ts` —— `GET /healthz`、`GET /readyz`（注入
  `APP_POOL` 做 `SELECT 1`；失败返回 503）。无 guard、不写审计。
- ✅ `apps/api/src/health/health.module.ts` —— 注册 controller，挂进 `AppModule`。
- ✏️ `apps/api/src/app.module.ts` —— `imports` 增 `HealthModule`。
- ✅ `apps/api/src/common/startup-env.ts` —— `assertRequiredEnv([...])`：汇总检查
  `APP_DATABASE_URL`/`TENANT_JWT_SECRET`/`PLATFORM_JWT_SECRET`/`S3_*` 等，缺失一次性报全。
- ✏️ `packages/database/src/client.ts` —— `.env` 加载同样改为「存在才加载、不覆盖」，
  使迁移/seed 容器也以注入 env 为准。

### 3.3 配置与文档（新增/修改）

- ✅ `.env.production.example` —— 生产环境变量样例，全部为安全占位符
  （`CHANGE_ME` 风格），含 `NODE_ENV=production`、`TRUST_PROXY=true`、`CORS_*`、强密钥提示。
- ✅ `docs/phase-3a-private-deployment-plan.md` —— 本文件（确认后落库）。
- ✏️ `README.md` —— 增「私有化部署（Docker Compose）」章节：构建、迁移、起服、健康检查、
  端口与反代说明；并指向 `security-hardening-plan.md` 的上线前清单。
- ✏️ `.gitignore` —— 确保 `.env.production` / `.env.production.local` 被忽略
  （`.env.*.local` 已忽略，补 `.env.production`）。

### 3.4 不在本期出现的文件（即 3B+ 才有，列此防误解）

- ✗ 任何 `db/migrations/04x_*.sql`（无新迁移）。
- ✗ 平台管理员 CLI 脚本（3B）。
- ✗ 备份/恢复脚本（3C）。
- ✗ `apps/admin/Dockerfile`（admin 暂不打包）。

---

## 4. 风险与回滚

### 4.1 风险

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | `main.ts`/`client.ts` 改 `.env` 加载逻辑，破坏本地 `pnpm dev`（开发仍靠根 `.env`） | 中 | 改为「文件存在才加载、不覆盖已存在 env」，本地 `.env` 仍被加载，行为对开发透明；改完跑本地 `pnpm dev` 全栈验证 |
| R2 | CORS 配置不当导致前端跨域被拒，或反之过度放开 | 中 | 默认**不**开 CORS（同源反代不需要）；仅在显式设 `CORS_ENABLED=true` 时按白名单开；样例中注释清楚 |
| R3 | `0.0.0.0` 绑定 + 生产 compose 误暴露 DB/Redis/MinIO 端口到公网 | 高 | compose.prod 默认这些服务**不映射**宿主端口（仅内部网络）；仅 `proxy` 暴露；文档强调；保留 `docker-compose.override.yml` 仅本机用的既有约定 |
| R4 | `/readyz` 暴露内部状态或被当探测面 | 低 | 只返回 `{status:ok\|fail}`，不含版本/连接串/租户数据；无鉴权但无敏感信息 |
| R5 | 生产镜像仍用 `tsx` 跑迁移（dev 依赖），运行期镜像若误带迁移工具链 | 中 | 迁移在独立 `migrate` init 容器跑（可含 dev deps）；**运行期 api 镜像**只装生产依赖、只 `node dist/main`，不含迁移工具，不拿超管串 |
| R6 | 镜像构建拉取基础镜像/依赖失败（内网/气隙） | 中 | 本期只保证「有网构建」；离线镜像包属 3D；文档注明 |
| R7 | 硬编码 app-role 密码（`000_app_role.sql`）在生产留弱口令 | 高（但本期不引入新风险） | 本期文档化：生产由运维在 init 用真实密码创建/改密 `kirindesk_app`；**代码层根治留 3B**，本期不动该已应用迁移（改它会触发 checksum 拒绝，见 security-hardening-plan §「不要手改已应用迁移」） |
| R8 | 前端相对 `/api` 在非同源部署（直连 API 域名）下失效 | 低 | 本期定的部署形态就是「同源反代」，文档明确；若客户要分域名，属 3D（前端引入 `VITE_API_BASE`） |

### 4.2 回滚

- **代码回滚**：3A 改动集中在新增文件 + `main.ts`/`client.ts`/`app.module.ts` 三处小修。
  单 commit（或按 3.1/3.2/3.3 分 commit），`git revert` 即可完全回到 `pnpm dev` 形态。
- **数据库回滚**：无变更，无需回滚。
- **运行回滚**：生产 compose 是新增文件，删除/不使用即可；现有本地 `docker-compose.yml` +
  `pnpm dev` 工作流完全不受影响（R1 缓解保证）。
- **验证回滚有效**：回滚后跑 §5 的「本地开发回归」即可确认旧路径仍绿。

---

## 5. 验收标准（Phase 3A）

### 5.1 质量门（不可降级，沿用 `pnpm verify:full`）

- [ ] `lint` / `format:check` / `typecheck` / `build` 全绿。
- [ ] 单元测试通过（新增 health/startup-env 的单测：`/readyz` DB 失败返回 503；
      `assertRequiredEnv` 缺变量时抛错并列出缺失项）。
- [ ] 集成测试 ≥ 现有基线（345）保持全绿（本期不应改变任何业务行为）。
- [ ] 安全回归 13/13 全绿（尤其启动期超管自检、JWT 失败即拒启不被破坏）。

### 5.2 本地开发回归（确保不破坏现状 —— R1）

- [ ] `pnpm dev` 仍能从根 `.env` 正常起 API+Web，登录/注册等既有流程不受影响。
- [ ] 现有 `docker-compose.yml`（infra）+ override（仅本机绑 127.0.0.1）行为不变。

### 5.3 容器化部署验收（核心）

- [ ] `docker compose -f docker-compose.prod.yml build` 成功产出 api、web 镜像。
- [ ] 起栈后 `migrate` init 容器成功跑完 42 个迁移并退出 0（用超管串）。
- [ ] 运行期 `api` 容器**只**注入 `APP_DATABASE_URL`，启动自检通过（非超管角色）；
      容器内 `printenv` 确认**无** `DATABASE_URL`（超管串）。
- [ ] `curl proxy/healthz` → 200；`curl proxy/readyz` → 200（DB 通）；停掉 postgres 后
      `/readyz` → 503（探活真实反映依赖）。
- [ ] 浏览器经反代端口访问 Web，能完成一次真实登录（用迁移+生产 seed 后的账号，或经
      §1.2/3B 之外的临时手段）；前端相对 `/api` 经 nginx 同源代理成功命中后端。
- [ ] `docker compose -f docker-compose.prod.yml ps` 中 postgres/redis/minio **未**映射宿主端口
      （仅内部网络），仅 proxy 暴露。

### 5.4 安全与信任校验（遵 §3/§4）

- [ ] `.env.production.example` 内无任何真实密钥，全为占位符；`git status` 确认未误加 `.env*`。
- [ ] CORS 默认关闭；显式开启时仅按白名单放行（用一次跨域请求验证拒绝/放行）。
- [ ] `/healthz`、`/readyz` 响应体不含连接串、版本指纹、租户数据。
- [ ] 镜像以非 root 用户运行（`docker exec ... whoami` 非 root）。
- [ ] 文档明确指向 `security-hardening-plan.md` 的「部署安全清单」与「上线前必须项」，
      并标注 R7（app-role 密码根治）属 3B。

### 5.5 文档验收

- [ ] README「私有化部署」节按步骤可复现 5.3 的起栈过程。
- [ ] 本规划文档落库为 `docs/phase-3a-private-deployment-plan.md`，并在 CLAUDE.md §10
      增 Phase 3A 条目（实施完成后）。

---

## 6. 实施顺序建议（确认后，按 §2 增量推进，每步可验证）

1. 健康检查 + 启动期 env 校验 + `.env` 加载加固（纯后端小改，先让 `pnpm verify:full` 绿）。
2. api / web Dockerfile + `.dockerignore`（先单独 `docker build` 通过）。
3. `docker-compose.prod.yml` + nginx 反代 + `migrate` init 容器（起栈、healthz/readyz 验证）。
4. `.env.production.example` + README + 本文档落库 + CLAUDE.md §10 更新。

> 每步完成后按 §9 汇报（文件增改、命令、测试结果、是否动 schema、是否产生 secret、遗留风险、下一步）。

---

## 7. 待确认问题（请在批准前一并答复）

1. **范围确认**：本期是否就锁定 Phase 3A（单机 compose 打包），3B/3C/3D 后续单独规划？
2. **反代/同源**：私有化首期是否接受「nginx 同源托管 Web + 反代 /api」的形态？
   （这样前端零改动；若需 Web 与 API 分域名，则要把 `VITE_API_BASE` 提到本期，工作量增加。）
3. **admin 应用**：确认本期**不**打包 `apps/admin`（当前为空壳）？
4. **迁移执行**：接受「独立一次性 `migrate` init 容器用超管串、运行期容器只用 app 串」的分离方式？
5. **app-role 密码根治（R7）**：确认本期仅文档规避、代码根治放 3B？
```
