# Phase 1L 规划 — 租户开通(Tenant Onboarding / Provisioning)

把平台控制台从「只能管理**已存在**的租户」补成「能**开通新租户**」的闭环:平台管理员
经平台身份创建一个租户 + 其首位 owner 用户 + **该租户的审计哈希链 genesis 行**,全程
一个事务、全程审计。本阶段的**第一要务**是堵住 1K-A 自己记下的那笔债——**新租户开通
时必须原子地建出 `audit_log_chains` 行**,否则 `AuditService` 对该租户的所有写审计会
**静默 no-op**(见 §1.3),让一个本应「全程可审计」的租户从出生起就审计失效。本文档为
Phase 1L 的规划,经用户确认后再按节实施;体量中等、单阶段可完成,不强制拆子阶段。

## 1. 目标与范围

### 1.1 背景与目标

KirinDesk 自 Phase 0 起就以多租户 SaaS 立项(CLAUDE.md §4:「LETPCBA 只是第一个租户,
绝不把它硬编码进系统逻辑」),且 1K-A/1K-B 已落地平台身份、租户生命周期闸门与受治理
的支持访问。但盘点现状,**「让一个新租户存在」这件事至今没有任何代码路径**:

- **租户只能靠 seed 出来**:今天数据库里的租户(dev-tenant、测试 fixtures 的
  TEST_TENANT_*)全部来自 `db/seeds/005_dev_tenant.sql` 或集成测试 fixtures 的手写
  `INSERT`。平台侧只有 1K-A 的 `GET /api/platform/tenants`(列表/详情)和
  `POST /:id/{suspend,deactivate,activate}`(生命周期)——**全部作用于已存在的租户**,
  没有任何 `POST /api/platform/tenants` 之类的**创建**端点。
- **「开通」是一组必须一起发生的事**:一个可用的租户至少要同时具备 ① `tenants` 行
  (status=active);② 至少一个能登录的 owner 用户(`users`,`is_tenant_owner=true`,
  bcrypt 初始密码);③ **该租户的审计链 genesis 行**(`audit_log_chains`,
  `chain_key='tenant:<id>'`,`last_hash=repeat('0',64)`)。seed 005 正是把这三件事
  一起做的(`tenants` + `users` + 两条 `audit_log_chains`),但**产品代码里没有任何
  服务复刻这套原子开通**。
- **这正是 1K-A 明确记下、尚未偿还的债**:1K-A 的设计说明里写到——「`AuditService`
  在租户没有 `audit_log_chains` 行时会**静默 no-op**;现有 seed/真实租户都有链行,但
  代码里**还没有租户开通服务**,所以当租户创建落地(1K-B 或更后)时,**它必须像
  seed 005 那样插入链行**」。1K-B 没有引入租户创建,这笔债顺延到本阶段。**Phase 1L
  就是偿还它的地方。**

本阶段目标:补上「租户开通」这条平台侧路径,且把**审计链 genesis 行的原子创建**作为
其不可省略的一部分,从而:

1. **平台可开通新租户**:平台管理员(平台身份)经一个**事务化**的开通服务,一次性
   建出 `tenants` 行 + 首位 owner 用户 + 该租户的 `audit_log_chains` genesis 行,三者
   **要么全部成功、要么全部回滚**——不存在「建了租户却没建链」的中间态。
2. **从出生即可审计**:新租户的第一条业务/治理操作起,`AuditService` 就能正常写入
   它自己的哈希链(因为链行已在开通事务里建好),`verify-chain` 从 genesis 即 PASS。
   彻底消除「审计静默失败」这一信任隐患(CLAUDE.md §3/§6:敏感操作必须可审计、审计
   不可被绕过)。
3. **开通本身留痕**:开通是平台侧敏感操作,须审计——平台管理员创建了哪个租户、何时、
   首位 owner 是谁(标识,不含密码),写入审计(落哪条链 §4 钉死)。

### 1.2 本阶段要做(范围内)

- **租户开通服务 + 平台端点**:`POST /api/platform/tenants`(平台身份),在**单个
  数据库事务**内依次:
  - 插入 `tenants` 行(name、slug 唯一、status=`active`、可选 contact_email/phone/
    timezone/locale);slug 冲突 → 409,不泄漏其它租户信息。
  - 插入首位 **owner 用户**(`users`,`is_tenant_owner=true`,bcrypt 初始密码,
    status=`active`);该租户内 email 唯一。
  - 插入 **`audit_log_chains` genesis 行**(`chain_key='tenant:<新id>'`、
    `tenant_id=<新id>`、`last_hash=repeat('0',64)`)——**本阶段的核心、不可省略**。
  - 回填 `tenants.owner_user_id`(列已存在,003 迁移)。
  - 事务提交后写**开通审计**(`tenant.created` 等,§4 定其落链与 metadata 形状)。
- **平台控制台开通页**:平台侧(kd_platform_token)`/platform/tenants` 列表页加一个
  「开通租户」入口 + 表单(name/slug/owner email/owner 初始密码或邀请、可选联系方式),
  提交后回到列表并能立即看到新租户(active)。复用 1K-B 已建的 `platform-client.ts` /
  `PlatformLayout` / 既有错误映射约定,无新依赖。
- **首位 owner 的凭证下发方式**(§3/§4 评估钉死):本阶段倾向**平台管理员设定初始
  密码**(最简、可调试),由平台管理员经带外渠道交付给客户,客户首登后自行改密;
  「邮件邀请链接」属 provider 抽象方向(§7 mock-first),本阶段不外发(见 §1.3)。
- **审计 + 可逆性 + 测试**:开通/失败回滚/slug 冲突/审计落链/链可验证,均有集成测试;
  若需新表/列则附迁移可逆性校验(初判**无需新表**——`tenants`/`users`/
  `audit_log_chains` 三表皆已存在,owner_user_id 列也在,**很可能零 migration**,
  详见 §2 评估)。

### 1.3 本阶段不做(范围外)

- **不做租户自助注册 / 计费 / 套餐升级**:开通是**平台管理员**侧的运营动作(同 1K
  的定位:本阶段租户生命周期只覆盖运营侧)。客户自助注册、`plans` 计费、试用转付费
  是独立方向,不在本阶段。
- **不做站外邮件/通知**(「邀请你成为某租户 owner,请点此设密」之类外发):通知是
  §7 provider 抽象方向(mock-first,未接真实邮件服务),本阶段 owner 凭证在产品内
  生成、带外交付,不外发。这与 1K「不外发授权通知」的边界一致。
- **不做租户硬删除 / 数据清除**:删除/停用仍走 1K-A 的 `deactivate`(只改 status,
  不删数据);本阶段只**新增**开通,不动删除语义。
- **不改既有审计写入路径 / 哈希算法 / append-only 约束**:本阶段**只复用**
  `AuditService` 与 `verify-chain`,并**补建**它依赖的链行——不改 022/023 触发器、
  不改 hash 算法/`hash_version`、不改链结构。我们偿还的是「链行没被建」的债,而非
  改审计机制本身。
- **不在开通流程里塞业务种子**(默认角色/权限矩阵的批量预置等):首位 owner 复用
  既有 RBAC(1H)路径自行建角色即可;是否给新租户预置一套默认角色,留 §3 评估,
  默认**不预置**(保持开通最小、可调试)。
- **不做批量开通 / 导入**:本阶段单租户开通;批量是后续优化。

### 1.4 与既有平台身份 / 租户隔离 / 审计设施的关系

本阶段严格复用、绝不削弱既有边界:

- **平台身份(复用)**:开通端点挂在既有 `@Controller('api/platform/tenants')` 下,
  用 1K-A 已有的 `PlatformAuthGuard`(platform-jwt、`tenantId: null`),与 1K-A 的
  list/getOne/lifecycle 端点同属一个平台模块,**不引入新身份、不改既有登录**。
- **`tenants` 是全局注册表(复用其「无 RLS」特性)**:`tenants` 无 RLS(全局表,1K-A
  已据此实现),故开通时的 `INSERT tenants` 由平台身份直接写入,天然不受 RLS 约束;
  这与 1K-A 的 list/lifecycle 同一路径,**不开任何后门**。
- **审计设施(复用,且这是本阶段的收口)**:开通后的 `tenant.created` 经既有
  `AuditService` 写入(session actor=system,被既有 `audit_logs_system_insert` policy
  允许,同 1K-A 的 `tenant.suspended` 写法,**无需新 audit_logs policy**);而新租户
  **自己的**链行在开通事务里建好,使其从第一条事件起即可正常入链、`verify-chain`
  从 genesis 即 PASS。**「链行的原子创建」是把『审计可绕过/静默失败』这一隐患从产品
  代码里彻底清除的关键一步,也是本阶段相对其它候选模块最值得先做的理由。**
- **租户隔离(复用且不放大)**:首位 owner 用户经既有 `users` 表(FORCE RLS、
  tenant_id NOT NULL)落库;开通后该 owner 经既有 `/api/auth/login`(带 slug)登录,
  其后的一切读写仍走既有 `withTenantContext` + RLS,**只见自己的租户**。开通流程
  不签发任何 token、不绕过任何租户上下文。

> **关键不变式(本阶段反复校验)**:`tenants` 行、owner `users` 行、
> `audit_log_chains` genesis 行,三者**在同一事务内原子产生**;任一失败则整体回滚,
> 不留「有租户无链」或「有租户无 owner」的半成品。这是 §1.1 第 2 点债务的根因修复,
> 后续 §2(数据模型)、§3(端点与事务边界)、§4(审计与护栏)、§6(测试,含
> 「开通后立即 verify-chain PASS」与「事务回滚不留半成品」用例)都围绕它展开。
