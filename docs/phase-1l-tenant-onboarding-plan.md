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

## 2. 数据模型与迁移评估

### 2.1 结论先行：**零 migration，零新表**

本阶段所有需要落库的数据**完全可以落进三张已存在的表**(`tenants` /
`users` / `audit_log_chains`),**不需要新增任何表或列**。原因逐项论证如下。

### 2.2 复用：`tenants`（migration 003 + 036）

| 列 | 类型 | 用途 | 已有？ |
|---|---|---|---|
| `id` | uuid PK DEFAULT uuid_generate_v4() | 开通后的租户 id | ✅ |
| `name` | varchar(200) NOT NULL | 租户显示名 | ✅ |
| `slug` | varchar(100) NOT NULL UNIQUE | 租户登录标识；UNIQUE 约束即 slug 冲突 → 409 | ✅ |
| `status` | varchar(20) DEFAULT 'active' | 新租户从 active 开始；CHECK('active'\|'suspended'\|'deactivated') 来自 migration 036 | ✅ |
| `owner_user_id` | uuid DEFAULT NULL | 回填首位 owner 的 user.id；见 §2.4 | ✅ |
| `contact_email` | varchar(255) | 可选联系信息 | ✅ |
| `contact_phone` | varchar(50) | 可选联系信息 | ✅ |
| `timezone` | varchar(50) DEFAULT 'Asia/Shanghai' | 可选，默认不变 | ✅ |
| `locale` | varchar(10) DEFAULT 'zh-CN' | 可选，默认不变 | ✅ |
| `created_at` / `updated_at` / `deleted_at` | timestamptz | 审计时间戳 | ✅ |

`tenants` **无 RLS**（全局注册表，1K-A 已据此实现 list/lifecycle，无需绕过任何
策略）。开通时平台身份直接用 raw pool connection 写入，与 1K-A
`PlatformTenantsService` 的写法一致。

### 2.3 复用：`users`（migration 005_users）

| 列 | 类型 | 用途 | 已有？ |
|---|---|---|---|
| `id` | uuid PK | owner 用户 id | ✅ |
| `tenant_id` | uuid NOT NULL REFERENCES tenants(id) | 开通事务已建好 tenants 行 | ✅ |
| `email` | varchar(255)；UNIQUE(tenant_id, email) | owner 邮箱；租户内唯一 | ✅ |
| `password_hash` | varchar(255) | bcryptjs BCRYPT_COST=12；与 1H UsersService.create 相同常量 | ✅ |
| `name` | varchar(100) NOT NULL | owner 名称 | ✅ |
| `status` | varchar(20) DEFAULT 'active' | 初始 active | ✅ |
| `is_tenant_owner` | boolean NOT NULL DEFAULT false | 首位 owner 设为 true | ✅ |
| `phone` | varchar(50) | 可选 | ✅ |
| `created_at` / `updated_at` / `deleted_at` | timestamptz | 审计时间戳 | ✅ |

`users` 有 **FORCE RLS**；开通服务在事务内须先 `set_config('app.current_tenant_id',
new_tenant_id, true)` 才能写入，与 `withTenantContext` 的做法等效——见 §2.5 的
事务顺序。

### 2.4 复用：`audit_log_chains`（migration 015）

| 列 | 类型 | 用途 | 已有？ |
|---|---|---|---|
| `id` | uuid PK | genesis 行 id | ✅ |
| `chain_key` | varchar(200) NOT NULL UNIQUE | `'tenant:<new_tenant_id>'` | ✅ |
| `tenant_id` | uuid REFERENCES tenants(id) | 关联新租户 | ✅ |
| `last_hash` | varchar(64) NOT NULL DEFAULT repeat('0',64) | genesis = 64 个零，与 seed 005 一致 | ✅ |
| `last_log_id` | bigint | 初始 NULL（没有第一条 audit_log 时） | ✅ |
| `updated_at` | timestamptz | 自动 | ✅ |

`audit_log_chains` **无 RLS**（无 FORCE RLS，无 policy）。`AuditService` 经
`set_config('app.current_actor_type','system',true)` 的 session 写入；genesis 行
由开通事务直接 `INSERT` 即可，无需任何特殊权限绕过。

### 2.5 ⚠️ 关键：`tenants.owner_user_id` 没有 FK 约束

`db/migrations/003_tenants.sql` 中 `owner_user_id uuid DEFAULT NULL`——**只是一个
裸 uuid 列，没有 `REFERENCES users(id)` 的外键约束**（留意：customers/sales_orders
/suppliers/purchase_orders 的 `owner_user_id` 各自有 FK；但 `tenants.owner_user_id`
没有，原因是若加上 FK 则 tenants→users→tenants 会构成循环引用，在同一事务内
先 INSERT tenants 再 INSERT users 再回填时会遇到约束校验顺序问题）。

这反而是本阶段的**好消息**：事务内部可以按以下顺序执行，无需 deferred constraint
或 INITIALLY DEFERRED 声明：

```
BEGIN
  1. INSERT INTO tenants (name, slug, status, contact_email, …)
        RETURNING id                     -- 得到 new_tenant_id
  2. set_config('app.current_tenant_id', new_tenant_id, true)
     set_config('app.current_actor_type', 'system', true)
                                         -- 为下一步 INSERT users 准备 RLS session
  3. INSERT INTO users
        (tenant_id, email, password_hash, name, is_tenant_owner=true, status='active', …)
        RETURNING id                     -- 得到 owner_user_id
  4. UPDATE tenants SET owner_user_id = <owner_user_id>, updated_at = now()
        WHERE id = new_tenant_id        -- 回填，裸 uuid 无 FK 问题
  5. INSERT INTO audit_log_chains
        (chain_key='tenant:<new_tenant_id>', tenant_id=new_tenant_id,
         last_hash=repeat('0',64))      -- genesis 行，关键一步
COMMIT
  (post-commit) AuditService.log(tenant.created, …)
```

若任一步抛异常，`ROLLBACK` 使三张表全部无新行——不留半成品。

### 2.6 RBAC seed 评估：无需改动

平台端点由 `PlatformAuthGuard`（platform-jwt）把关，**不走租户 RBAC**；租户侧目前
没有「允许 owner 自助创建子租户」的需求（本阶段开通是运营侧动作）。因此：
- **不新增权限码**：不改 `db/seeds/002_permissions.sql`，不改测试 fixtures。
- 首位 owner 登录后使用既有 1H RBAC 自行建角色/分配权限，开通服务不预置角色
  （§1.3 已说明：默认最小开通，可调试）。

### 2.7 密码安全约定（钉死，不可降级）

- 初始密码经 **`bcryptjs.hash(password, 12)`**（BCRYPT_COST=12，与 1H `UsersService`
  一致）存为 `password_hash`；**明文绝不落库、绝不写审计、绝不出现在任何响应体**。
- 开通端点的响应体**不含 `password_hash`**（与 1H `UsersService.create` 的 response
  DTO 约定相同：USER_COLS 显式剔除 hash 列）。
- 开通审计的 `metadata_json` 只含 `{tenantId, tenantSlug, ownerEmail, ownerUserId}`
  ——**不含密码、不含 hash**（见 §4）。
- 初始密码的下发方式（平台管理员设定后经带外渠道交付给客户）不在代码里固化，属操作
  流程，见 §1.2。

### 2.8 数据模型小结

| 项目 | 结论 |
|---|---|
| 新表 | 无 |
| 新列 | 无 |
| Migration | **不需要（零 migration）** |
| 涉及表 | `tenants`（003+036）/ `users`（005）/ `audit_log_chains`（015） |
| 循环 FK 问题 | 不存在（`tenants.owner_user_id` 无 FK，裸 uuid，回填安全） |
| RLS 处理 | `tenants` 无 RLS → 直接写；`users` FORCE RLS → 事务内先 set_config；`audit_log_chains` 无 RLS → 直接写 |
| 密码 | bcrypt cost 12，绝不出响应体/审计 |
| RBAC seed | 不变 |

## 3. 后端 API 端点

本阶段只新增**一个端点**(`POST /api/platform/tenants`),挂在既有
`PlatformTenantsController`(`@Controller('api/platform/tenants')`,
`PlatformAuthGuard`)下——和 1K-A 的 list / getOne / lifecycle 共享同一模块,不引入
新模块。服务层新增 `TenantOnboardingService`(依赖 `APP_POOL` + `AuditService`,
不依赖 `withTenantContext`——理由见 §3.3)。

### 3.1 端点总览

| 方法 & 路由 | 守卫 | HTTP 状态 | 说明 |
|---|---|---|---|
| `POST /api/platform/tenants` | `PlatformAuthGuard` | 201 | 原子开通:建租户 + owner 用户 + genesis 链行;审计 `tenant.created`。 |

既有只读端点(`GET /api/platform/tenants`、`GET /api/platform/tenants/:id`)和
生命周期端点(`POST /:id/{suspend,deactivate,activate}`)保持不变。

### 3.2 DTO 规格(钉死)

```
CreateTenantDto {
  name:          @IsString @IsNotEmpty @MaxLength(200)      // 租户显示名
  slug:          @IsString @IsNotEmpty @MaxLength(100)
                 @Matches(/^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/ 或类似)
                             // URL 安全；UNIQUE 约束的业务面
  ownerEmail:    @IsEmail                                   // 首位 owner 登录邮箱
  ownerPassword: @IsString @MinLength(8)                    // 初始密码(明文只活在 DTO,
                                                            // bcrypt(12) 后落库,绝不出响应/审计)
  ownerName:     @IsString @IsNotEmpty @MaxLength(100)      // owner 姓名
  contactEmail:  @IsEmail @IsOptional
  contactPhone:  @IsString @IsOptional @MaxLength(50)
  timezone:      @IsString @IsOptional @MaxLength(50)       // 默认 'Asia/Shanghai'
  locale:        @IsString @IsOptional @MaxLength(10)       // 默认 'zh-CN'
}
```

响应体(`201 Created`)：`TenantOnboardingResult`

```
{
  tenant: {
    id, name, slug, status,
    contactEmail, contactPhone, timezone, locale,
    createdAt, updatedAt
  },
  owner: {
    id, tenantId, email, name, status, isOwner: true, createdAt
    // password_hash 绝不出现在此处
  }
}
```

**禁止出现在响应/审计里的字段**：`password_hash`、`ownerPassword` 原文、任何密码相关明文。

### 3.3 服务层事务边界(钉死)

开通逻辑放在 `TenantOnboardingService.provision()` 里。它直接用 `APP_POOL`（raw
connection），**不用** `withTenantContext`——原因是 `withTenantContext` 在事务开头
会 `set_config('app.current_tenant_id', tenantId, true)` + 以 `kirindesk_app` 角色
执行；而 `tenants` 表无 RLS、`audit_log_chains` 无 RLS，只有第二步 `INSERT users`
才受 FORCE RLS。因此手动管理 session config，既能明确控制 RLS session，又与
1K-A `PlatformTenantsService` 的写法一致。

**事务内步骤（顺序钉死，不可乱序）**：

```
BEGIN
  ① bcrypt.hash(ownerPassword, 12)            // BEGIN 之前，hash 计算放在事务外
                                               // （避免持锁时做 CPU 密集运算）

  ② INSERT INTO tenants
        (name, slug, status='active', contact_email, contact_phone, timezone, locale)
        RETURNING id, ...                      // 得 new_tenant_id；
                                               // slug UNIQUE 冲突 → pg 抛 23505 → 409

  ③ SET LOCAL app.current_tenant_id = '<new_tenant_id>'
     SET LOCAL app.current_actor_type = 'system'
                                               // 为 users FORCE RLS 准备 session

  ④ INSERT INTO users
        (tenant_id, email, password_hash, name, status='active', is_tenant_owner=true)
        RETURNING id, ...                      // 得 owner_user_id；
                                               // tenant 内 email UNIQUE → 23505 → 409

  ⑤ UPDATE tenants SET owner_user_id = <owner_user_id>, updated_at = now()
        WHERE id = new_tenant_id               // 回填；裸 uuid，无 FK 问题（§2.5）

  ⑥ INSERT INTO audit_log_chains
        (chain_key='tenant:<new_tenant_id>',
         tenant_id=new_tenant_id,
         last_hash=repeat('0',64))             // ★ genesis 行；关键步骤
                                               // chain_key UNIQUE，若已存在 → 25P02
                                               // （正常不会发生；若发生则 ROLLBACK → 500）
COMMIT

  ⑦ (post-commit, best-effort) AuditService.log(...)  // § 4 定其形状与落链
```

**bcrypt 在事务外**：`hash(ownerPassword, 12)` 是 CPU 密集操作，在 `BEGIN` 之前完成，
不持数据库连接等待，与 1H `UsersService.create` 的做法一致。

**错误映射（服务层抛，控制器不再转换）**：

| pg error code | 场景 | HTTP |
|---|---|---|
| `23505` + constraint `tenants_slug_key` | slug 已被占用 | **409** ConflictException(`slug 已存在`) |
| `23505` + constraint `users_tenant_id_email_key` | 租户内 email 重复（极罕见：同一事务内第一次 INSERT） | **409** ConflictException(`owner 邮箱已存在`) |
| `23505` + `audit_log_chains_chain_key_key` | genesis 行重复（不应发生）| **500** InternalServerErrorException |
| 其他 db 错误 | | **500**（抛原始 error，让 NestJS 全局过滤器处理） |

### 3.4 幂等与重复开通防护

- slug 的 UNIQUE 约束（数据库层）是最终防线；应用层在 INSERT 前**不**做 SELECT-then-INSERT（避免 TOCTOU），直接 INSERT 捕 23505。
- 同一 slug 重试（如网络超时后客户端重放）→ 409；客户端应展示「该标识已存在，请换一个或查询现有租户」。
- **不做幂等 upsert**（UPSERT ON CONFLICT DO UPDATE 会覆盖已存在租户的数据）；
  幂等性由调用方（平台管理员）通过 list 确认后决定是否重试。

### 3.5 dataScope / 隔离小结

- 开通端点是**平台侧操作**（PlatformAuthGuard），不受租户 RBAC / dataScope 约束。
- 开通后，新租户的 owner 登录走**既有** `/api/auth/login`（需 tenantSlug），之后的
  一切读写经 `withTenantContext` + RLS，只见自己的租户——开通服务不签发任何 tenant
  token，不干预后续租户上下文。
- 平台管理员**看不到新租户的业务数据**：`TenantOnboardingResult` 只含元信息（§3.2），
  与 1K-A 的 `TenantSummary` 响应形状一致，**不含任何业务表数据**。

### 3.6 不做的端点

- 无租户「更新元信息」端点（name/contactEmail 等字段修改）：本阶段只做开通，不做
  完整 CRUD；更新留给后续阶段。
- 无「删除租户」端点：停用走 1K-A 的 `POST /:id/deactivate`，不物理删除。
- 无「重置 owner 密码」端点：owner 登录后走既有 1H 用户管理自行改密；平台侧重置
  属凭证管理，留后续。
- 无租户侧「自助创建子租户」端点（CLAUDE.md §4：LETPCBA 是第一个租户，不做跨租户
  层级）。

## 4. 安全护栏与审计

本阶段的敏感点集中在三处：**密码安全**（初始密码绝不外泄）、**原子性**（不留半
成品租户）、**平台身份边界**（开通是平台管理员动作，租户侧无法触发）。所有判定
服务端强制（CLAUDE.md §4），以下逐项钉死。

### 4.1 护栏（服务端强制）

1. **密码绝不出响应体 / 审计 / 日志（最高优先级）**  
   `ownerPassword` 只活在 DTO 校验层 → 立即 `bcrypt.hash(password, 12)` → hash
   落库；明文此后在内存中无引用。响应体（§3.2 `TenantOnboardingResult`）使用显式
   列白名单，**永不含** `password_hash` 或原文密码。审计 `metadata_json` 只记
   `{ tenantId, tenantSlug, ownerEmail, ownerUserId }`——**ownerPassword
   / password_hash 一律不出现**。NestJS 全局序列化层（plainToInstance +
   `excludeExtraneousValues`）作为第二道拦截，与 1H `UsersService` 约定一致。

2. **原子性——三行要么全建、要么全无**  
   `tenants` / `users` / `audit_log_chains` 三条 INSERT 在同一数据库事务内（§3.3）；
   任一步抛异常即整体 ROLLBACK。**不存在「有租户无链」或「有租户无 owner」
   的半成品**。`audit_log_chains` genesis 行写失败（如 chain_key 重复冲突）→ 事务
   回滚 + 500，绝不提交一个无链的租户。

3. **平台身份守卫——租户侧不可触发开通**  
   端点挂在 `@Controller('api/platform/tenants')` + `@UseGuards(PlatformAuthGuard)`
   下；tenant-jwt 无效（PlatformAuthGuard 只接受 platform-jwt）→ **401**。无任何
   租户侧权限码绑定该端点；租户用户即使持 `support_access:grant` 等高权限也无法
   访问（不同身份类型，§1.4）。

4. **输入校验 + 防注入（DTO 白名单）**  
   `CreateTenantDto` 使用 `@IsString`/`@IsEmail`/`@MaxLength`/`@Matches` 校验（§3.2）；
   `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` 全局已启用——
   未声明字段被拒绝（400），防止额外字段污染。slug 格式限 `[a-z0-9-]`（lowercase
   URL 安全），由 `@Matches` 校验；`UNIQUE` 约束是数据库最终防线。

5. **slug 冲突防 TOCTOU——直接 INSERT 捕 23505**  
   不做 SELECT-then-INSERT（存在竞态）；直接 INSERT，捕 PostgreSQL `23505`
   (`unique_violation`) → **409** ConflictException。其他约束冲突（email 重复等）
   同理处理（§3.3 错误映射表）。

6. **平台管理员不冒名**  
   开通后的 `tenant.created` 审计 `actor_type='platform_admin'`、`actor_id=JWT sub`；
   不签发任何 tenant-jwt、不模拟任何租户用户身份。开通事务内的 `SET LOCAL
   app.current_actor_type='system'` 仅用于使 `users` FORCE RLS 允许写入（系统级
   INSERT），不改 audit 里的 actor（audit 在事务后以 platform_admin 身份写）。

7. **响应不含新租户业务数据**  
   `TenantOnboardingResult`（§3.2）只含元信息（id/name/slug/status/contactEmail/
   createdAt 等）和 owner 摘要；无订单/客户/金额等任何业务表数据（CLAUDE.md §3/
   §4）。

8. **开通失败不留痕迹**  
   事务回滚后数据库无新行——不存在「slug 被占用但 400 已返回、下次 409」的状态不
   一致。失败响应（409/400/500）不泄漏已有租户信息（slug 冲突只说「已存在」，不
   返回冲突行的数据）。

### 4.2 审计（落链与形状钉死）

开通是平台管理员的**敏感写操作**，必须审计（CLAUDE.md §6）。

| action | actor_type | 落链 | resource_type / id | metadata（只含标识，无密码/业务明文） |
|---|---|---|---|---|
| `tenant.created` | `platform_admin` | **租户链**（`tenant:<new_id>`，genesis 行已在事务内建好）| `tenant` / `new_tenant_id` | `{ tenantSlug, ownerEmail, ownerUserId }` |

**说明：**

- **落租户链**（不落 platform 链）：让新租户自己能在 1I 审计查看器看到「我是何时
  被谁开通的」；platform 链不记租户内部事件（与 1K-A `tenant.suspended/activated`
  落租户链的逻辑一致）。
- **post-commit 写审计**：`AuditService.log(...)` 在 `COMMIT` 后调用（§3.3 步骤
  ⑦），此时 genesis 行已在，哈希链可正常延伸。若 audit 写失败，**事务已提交、租户
  已存在**——这是 best-effort 同 1K-A `transition()` 相同的取舍；但因 genesis 行是
  开通事务里的一部分，链完整性本身不受影响（genesis 本身没有 audit_log 条目，失败
  只是少了这一条 `tenant.created`；后续操作仍可正常入链）。
- **metadata 不含密码任何形式**（§4.1 第 1 条最终校验点）。

### 4.3 对既有安全边界的影响评估

| 边界 | 影响 |
|---|---|
| RLS 租户隔离 | **不变**：新租户开通后，其行数据天然受 FORCE RLS 隔离，其他租户不可见 |
| append-only 审计链 | **不变**：genesis 行只是 audit_log_chains 里的一条初始行，022/023 触发器、hash 算法、hash_version 均未改动 |
| 平台身份与租户身份分离 | **不变**：开通走 platform-jwt，使用 platform 身份；开通完成后新租户 owner 经既有 `/api/auth/login` 登录（tenant-jwt），两套身份无交叉 |
| 全局租户状态闸门（1K-A） | **增强**：新租户开通时 status='active'，开通后立即通过闸门，无需特殊处理 |
| 不可变 audit_logs 策略 | **不变**：不新增任何 audit_logs policy，开通审计经既有 `audit_logs_system_insert` policy 写入 |

## 5. 前端页面与导航

本阶段前端交付集中在**平台侧**（kd_platform_token），完全复用 1K-B 已建的
`platform-client.ts` / `PlatformLayout` / `PlatformAuthContext` / 既有错误映射约定，
**无新依赖、无新路由树**。租户侧（kd_access_token）**无任何新页面**——新租户 owner
登录后直接使用既有所有页面，开通本身只是平台运营动作。

### 5.1 改动范围一览

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `apps/web/src/lib/types.ts` | 新增类型 | `CreateTenantInput`、`TenantOnboardingResult` |
| `apps/web/src/lib/platform-client.ts` | 新增方法 | `provisionTenant(input)` → `POST /api/platform/tenants` |
| `apps/web/src/platform/PlatformTenantsPage.tsx` | 修改（纯加法）| 列表页加「开通租户」入口 + 行内展开表单，不新建页面文件 |
| `apps/web/src/App.tsx` | **不改** | 路由已有 `/platform/tenants` → `PlatformTenantsPage`，无需新增 |
| `apps/web/src/platform/PlatformLayout.tsx` | **不改** | 导航已有「租户」链接 |

**零新页面文件、零新路由**：开通表单作为 `PlatformTenantsPage` 内的**可展开面板**
实现（点击「开通租户」按钮展开，成功后收起并刷新列表），与 1K-B 的
`ActionDialog`（confirm panel）模式一致，保持平台控制台页面数量最小。

### 5.2 新增类型（`lib/types.ts`）

```ts
// POST /api/platform/tenants 请求体（对应后端 CreateTenantDto）
export interface CreateTenantInput {
  name: string;
  slug: string;
  ownerEmail: string;
  ownerPassword: string;   // 只活在内存；绝不写 localStorage/sessionStorage/URL
  ownerName: string;
  contactEmail?: string;
  contactPhone?: string;
  timezone?: string;
  locale?: string;
}

// 201 响应体（对应后端 TenantOnboardingResult，无 password_hash）
export interface TenantOnboardingResult {
  tenant: PlatformTenantSummary;
  owner: {
    id: string;
    tenantId: string;
    email: string;
    name: string;
    status: string;
    isOwner: boolean;
    createdAt: string;
  };
}
```

### 5.3 新增 platform-client 方法

```ts
provisionTenant(input: CreateTenantInput): Promise<TenantOnboardingResult> {
  return platformRequest<TenantOnboardingResult>('/api/platform/tenants', {
    method: 'POST',
    body: input,
  });
},
```

### 5.4 `PlatformTenantsPage` 修改（纯加法）

在现有列表页顶部加一个**「开通租户」按钮**，点击展开一个 inline 表单面板
（`ProvisionPanel`，页面内局部组件，不独立页面文件）。

**表单字段**（对应 §3.2 DTO，全部明确 label）：

| 字段 | 控件 | 校验（客户端快速反馈） |
|---|---|---|
| 租户名称 | `<input>` | 必填，maxLength 200 |
| 租户标识（slug） | `<input>` | 必填，pattern `[a-z0-9][a-z0-9-]*[a-z0-9]`，提示「小写字母/数字/连字符」 |
| Owner 邮箱 | `<input type="email">` | 必填，email |
| Owner 初始密码 | `<input type="password">` | 必填，minLength 8；**`autocomplete="new-password"`** |
| Owner 姓名 | `<input>` | 必填，maxLength 100 |
| 联系邮箱（可选） | `<input type="email">` | 可选 |
| 联系电话（可选） | `<input>` | 可选 |

**交互流程：**
1. 点击「开通租户」→ 面板展开（`showForm=true`），字段清空。
2. 填写 → 点「确认开通」→ 调 `platformClient.provisionTenant(input)`。
3. 成功（201）→ 面板收起，`load()` 刷新列表，新租户行出现在列表顶部（列表按
   `created_at DESC`），短暂展示「已开通：<name>（<slug>）」成功提示。
4. 失败：409 slug 冲突 → 「该标识已被占用，请换一个」；409 email 冲突 → 
   「Owner 邮箱已存在」；400 → 展示 server 返回的 message（DTO 校验失败）；
   其他 → 通用「开通失败，请稍后重试」。**错误内联在面板内，不崩页。**
5. 提交中禁用所有字段 + 按钮（防重复提交）。

**隐私约定（与 §4.1 对应）：**
- `ownerPassword` 只活在组件 `useState`；**绝不写 `localStorage` /
  `sessionStorage` / URL**；成功/失败后立即清空（`setPassword('')`）。
- 成功响应（`TenantOnboardingResult`）只含元信息，前端渲染 tenant.name /
  slug / owner.email ——**无密码字段**（后端已保证，前端也不缓存响应体）。
- 零 `console.*` 输出（浏览器 QA spot-check，§6.4）。

### 5.5 导航与路由

- **零新路由**：开通入口在 `/platform/tenants`（现有路由），无需 `/platform/tenants/new`。
- **零导航改动**：`PlatformLayout` 已有「租户」链接指向 `/platform/tenants`。

### 5.6 租户侧：无任何改动

新租户 owner 使用既有 `/login`（填 tenantSlug）即可登录，之后的所有功能（1H 用户
/角色管理、1A–1F 业务模块、1I 审计、1J 导出等）直接可用，**无需任何租户侧页面
改动**。开通给了他一个可用的租户，RBAC 里还没有角色（owner 本身不预置角色——§2.6）；
首次登录后 owner 可在 `/roles` 建角色、`/users` 邀请成员。

## 6. 测试

后端以 **vitest 集成测试**为主（`apps/api/test/tenant-onboarding.integration.test.ts`，
supertest 打真实 HTTP，跑在 `kirindesk_test`，复用 `setup-integration` + `fixtures`），
覆盖原子开通/冲突/审计落链/回滚/密码不泄漏/guard；前端走浏览器 QA（Playwright，
平台身份）。提交前置仍是 `pnpm verify` 全绿。本阶段**零 migration**，无需迁移
可逆性校验（无新 migration 可回滚）。

### 6.1 测试前置：fixture

- **全量迁移自动应用**：`setup-integration` 已运行 `pnpm --filter @kirindesk/database migrate`；
  最新 migration 为 037，无新 migration，无额外步骤。
- **fixture 不变**：本阶段无新权限码、无新种子表——`fixtures.ts` 不需要改动。
- **测试内自建租户**：开通测试会通过 HTTP 创建新租户（slug 随机，避免冲突）；
  teardown 用 owner DB 连接（`process.env.DATABASE_URL`，绕过 RLS）清除测试行，
  与 1K-B 的 `deleteGrant` 清理模式一致。
- **⚠️ 密码明文只在测试内存中**：测试用常量密码（如 `'TestPass123!'`）仅用于
  `POST` body 和随后的登录验证；**不写入任何 fixture 文件、不 console.log**。

### 6.2 集成测试用例（tenant-onboarding.integration.test.ts）

**正常开通（核心链路）**

- `POST /api/platform/tenants`（platform token）→ **201**；响应含
  `tenant.{id,name,slug,status:'active'}` + `owner.{id,email,name,isOwner:true}`；
  **响应体不含** `password_hash` / `ownerPassword`（断言 `JSON.stringify(body)`
  不含这两个字符串）。
- 开通后立即 `GET /api/platform/tenants` → 新租户在列表中（按 slug 或 id 找到）。
- **三行原子落库**：用 owner DB 连接直接查：
  - `SELECT id FROM tenants WHERE slug = $1` → 有一行，status='active'；
  - `SELECT id, is_tenant_owner FROM users WHERE tenant_id = $1` → 有一行，
    `is_tenant_owner=true`；`owner_user_id` 回填正确；
  - `SELECT chain_key FROM audit_log_chains WHERE chain_key = 'tenant:<id>'` →
    有一行，`last_hash=repeat('0',64)`（genesis）。
- **genesis 链立即可验**：开通后调 `GET /api/platform/support/tenants/<id>/...`
  等是否可以已经用 `verify-chain` 脚本（或直接查 audit_log_chains）确认链可延伸——
  或更直接：开通后立即 `POST /api/auth/login {email, password, tenantSlug}` 以新
  owner 身份登录（**验证密码正确**）→ 200 + accessToken；再 `GET /api/audit-logs`
  → 200（链行存在，审计可写入）。
- **开通审计**：owner DB 连接查 `SELECT action, actor_type, metadata_json FROM
  audit_logs WHERE tenant_id = <new_id>` → 有一行 `action='tenant.created'`，
  `actor_type='platform_admin'`，`metadata_json` 含 `tenantSlug` + `ownerEmail` +
  `ownerUserId`，**不含** `password` / `hash` 任何形式。

**错误与护栏**

- **slug 冲突 → 409**：用已存在的 slug（如 `TEST_TENANT_SLUG`）发 POST → 409；
  响应 message 含「已存在」类文案；DB 中无新租户行、无新链行（回滚验证）。
- **slug 格式非法 → 400**：`slug: 'UPPER_CASE'` 或 `slug: '-bad-start'` → 400
  DTO 校验失败（`@Matches` 拒绝）。
- **ownerPassword 过短 → 400**：`ownerPassword: '123'`（< 8 字符）→ 400。
- **ownerEmail 格式非法 → 400**：`ownerEmail: 'not-email'` → 400。
- **缺必填字段 → 400**：空 `name` → 400；缺 `slug` → 400。
- **未知字段 → 400**：`forbidNonWhitelisted` 已全局启用，发 `{ extraField: 'x' }` → 400。
- **租户 token → 401**（PlatformAuthGuard 拒绝 tenant-jwt）。
- **无 token → 401**。
- **回滚完整性**：slug 冲突后，owner DB 查 `users WHERE email = <ownerEmail>` +
  `audit_log_chains WHERE chain_key = 'tenant:<would-be-id>'` → 均无新行
  （无半成品）。

**密码安全（DB 层验证）**

- 开通成功后，owner DB 连接查 `SELECT password_hash FROM users WHERE id = <ownerId>` →
  `password_hash` 以 `$2b$` 开头（bcrypt hash）；**不等于** `ownerPassword` 原文。
- `SELECT * FROM audit_logs WHERE tenant_id = <newId>` → `metadata_json` 字段用
  `CAST ... AS text` 检索，断言**不含** `'TestPass'`（或测试密码前缀）——密码未
  进入审计。

**新租户立即可用（闭环验证）**

- 新 owner 登录（`POST /api/auth/login`）→ 200 + token；
- 以该 token `GET /api/customers`（tenant 业务端点）→ **200**（不是 403/500）；
- `GET /api/audit-logs` → **200**，链存在；
- `GET /api/audit-logs/chain/verify` → **200**，`ok: true`（verify-chain PASS）；
  此时链里至少有 `tenant.created` 那一条（`total >= 1`）。

### 6.3 单元测试（轻量）

本阶段逻辑集中在服务层事务边界（§3.3），无复杂状态机或独立可提取的纯函数。以下
单测价值较高：

- **slug 格式正则**：若把 `@Matches` 的 pattern 抽成常量，单测几个合法/非法 slug
  （`'hello-world'` 合法；`'Hello'` 非法；`'-start'` 非法；`'a'`
  一字符是否允许视 pattern 定义）。
- **DTO 响应不含 hash**：若 `TenantOnboardingResult` 使用 class-transformer
  `@Exclude()` 标注，单测序列化后无 `password_hash` 字段（同 1H
  `UsersService` 的 `USER_COLS` 白名单测试模式）。
- 其余覆盖由集成测试承担（事务/回滚/bcrypt 已在 6.2 覆盖）。

### 6.4 浏览器 QA（Playwright + 真实 Chromium，平台身份）

两台 dev server 均须运行（`:3001` API + `:5173` web via Vite proxy），同 1K-B §6.4。

**覆盖场景：**

- 平台管理员登录 `/platform/login` → 进 `/platform/tenants`。
- 点「开通租户」→ 展开表单：填 name/slug/ownerEmail/ownerPassword/ownerName → 点
  「确认开通」→ 成功提示 + 列表出现新租户行（运行中）。截图留证。
- slug 冲突：再次以**相同 slug** 提交 → 表单内联显示「该标识已被占用」，页面不
  崩溃。截图留证。
- 无权限用户（无 platform token 或 tenant token）尝试访问
  `http://localhost:5173/platform/tenants` → 重定向到 `/platform/login`（PlatformProtectedRoute）。
- **隐私 spot-check**：表单提交成功后，`localStorage` / `sessionStorage` 不含
  `ownerPassword` 字段值；URL 保持 `/platform/tenants`（密码不进 URL）；零
  `console.*` 输出（同 1K-B §6.4 约定）。

### 6.5 质量门槛

- `pnpm verify` 全绿：lint / format / typecheck / build / unit / integration
  （现有 289 + 本阶段新增用例）/ security 13/13。
- 集成新增用例数预估：**~12 个**（正常链路 5 + 错误与护栏 6 + 密码安全 2，
  部分可合并为同一 `it`）。
- 浏览器 QA 截图 ≥ 3 张（开通成功、slug 冲突内联错误、privacy 检查通过）。

## 7. 风险与回滚

本阶段**零 migration、纯加法**（只增端点 + 服务 + 前端表单），回滚面比含迁移的
1K 小得多；但仍有三处需要审慎对待：**密码操作**（不可逆的 bcrypt + 明文不留漏）、
**原子事务**（三行一起或一起没有）、**新租户立即被 1K-A 闸门和 RLS 管控**（开通
代码若出 bug 可能产生无效半成品行）。

### 7.1 风险与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| **半成品租户（有 tenants 行、无链行 / 无 owner）** | 高 | 三条 INSERT 在同一事务；任一失败整体 ROLLBACK（§3.3），不存在中间态；集成测试钉死回滚后三表均无新行（§6.2 回滚完整性用例）。 |
| **密码明文泄漏（响应体 / 审计 / 日志）** | 高 | DTO 响应白名单 + NestJS class-transformer 双重拦截；`metadata_json` 只含标识字段；集成测试断言 `JSON.stringify(body)` 不含 `password_hash` / 原文前缀（§6.2 密码安全用例）；前端 `ownerPassword` 只活在 React state，成功后立即清空（§5.4）。 |
| **slug TOCTOU 竞态（SELECT-then-INSERT）** | 中 | 不做预检 SELECT；直接 INSERT 捕 `23505`；UNIQUE 约束是数据库最终防线（§3.4）。 |
| **owner 用户 RLS 写入失败（SET LOCAL 遗漏）** | 中 | 步骤 ③ 在 `INSERT users` 之前明确 `SET LOCAL app.current_tenant_id` + `current_actor_type='system'`（§3.3）；集成测试验证 owner 行落库（§6.2 三行落库断言）。 |
| **audit_log_chains genesis 行缺失（chain_key 重复冲突）** | 中 | chain_key 为 `'tenant:<uuid>'`，uuid 由 pg 生成，实践中唯一；若仍 23505，事务 ROLLBACK + 500——开通未完成，不留无链租户；不做 `ON CONFLICT DO NOTHING`（静默失败不可接受）。 |
| **新租户 1K-A 全局闸门误判 / 开通后无法登录** | 低-中 | 新租户 status='active'（默认），闸门只拦 non-active；开通事务提交后 owner 立即可用；集成测试钉死「owner 登录 → 200」（§6.2 新租户立即可用）。 |
| **ownerPassword 进入 audit / logs（日志框架自动序列化）** | 低-中 | `CreateTenantDto` 中 `ownerPassword` 在进入服务层前已 hash、且 DTO 对象不传给 AuditService；NestJS 请求日志不记 body（已有配置）；集成测试 DB 层校验 audit metadata 无密码（§6.2）。 |
| **开通表单 ownerPassword 残留 localStorage / URL** | 低 | 字段为 `<input type="password">`、`autocomplete="new-password"`；组件 unmount / 成功后 `setPassword('')`；浏览器 QA spot-check 验证（§6.4）。 |
| **前端表单重复提交（网络超时重试）** | 低 | 提交中禁用所有字段 + 按钮（§5.4）；服务端 slug UNIQUE 兜底 → 409 明确提示而非静默重建。 |

### 7.2 回滚方案

本阶段**零 migration**，回滚只涉及代码层：

- **后端**：`TenantOnboardingService` + `PlatformTenantsController` 的新 `POST`
  路由 → `git revert` 对应提交，净移除。不影响既有 list / getOne / lifecycle
  端点；不影响 `audit_log_chains`（开通失败时事务回滚无新行；开通成功后 revert
  代码不删除已存在的租户/链行——已开通的租户数据不会因代码回退而消失，这是预期）。
- **前端**：`ProvisionPanel` + `platform-client.provisionTenant` + 新增类型 →
  `git revert`，净移除。`PlatformTenantsPage` 回到开通按钮之前的状态（列表 + 生命
  周期操作），其余平台控制台功能完全不受影响。
- **已开通租户的处置**：若回退代码后仍有已开通租户不应存在，用平台控制台
  `POST /:id/deactivate`（1K-A 端点）停用即可；若需彻底清除，由 DBA 执行带外
  DELETE（数据删除是运营判断，不在自动回滚脚本内，CLAUDE.md §5 要求确认）。
- **不可逆操作（bcrypt hash）**：密码 hash 写库后，原文不可还原——这正是密码安全
  的设计目标，非回滚项；若 owner 丢失密码，走既有 1H 管理员重置密码流程。
- **审计留痕不受影响**：若开通后又 deactivate，`tenant.created` / `tenant.deactivated`
  均已在链里，`verifyChain` PASS 不变；代码回退不影响已写审计行（append-only）。

## 8. 验证命令与验收标准

### 8.1 验证命令

**完整质量门槛（提交前置）**

```bash
pnpm verify   # lint + format:check + typecheck + build + unit + integration + security 13
```

**分步 / 定向（开发中）**

```bash
# 仅本模块集成测试
pnpm --filter @kirindesk/api test:integration -- tenant-onboarding

# 自动修格式（静默修，绿了再报告）
npx prettier --write \
  "apps/api/src/platform-tenants/**/*.ts" \
  "apps/web/src/platform/PlatformTenantsPage.tsx" \
  "apps/web/src/lib/platform-client.ts" \
  "apps/web/src/lib/types.ts"

# 前端类型 + 构建
pnpm --filter @kirindesk/web typecheck
pnpm --filter @kirindesk/web build
```

**本地冒烟（API :3001 运行中，dev DB）**

```bash
# 1. 平台登录
PTOK=$(curl -s -X POST localhost:3001/api/platform-auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"platform@dev.local","password":"dev-password-123"}' \
  | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')

# 2. 开通新租户（slug 随机）
SLUG="qa-onboard-$(date +%s)"
RESP=$(curl -s -X POST localhost:3001/api/platform/tenants \
  -H "Authorization: Bearer $PTOK" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"QA Onboard\",\"slug\":\"$SLUG\",
       \"ownerEmail\":\"owner-$SLUG@qa.local\",
       \"ownerPassword\":\"TestPass123!\",
       \"ownerName\":\"QA Owner\"}")
echo "$RESP" | grep -q '"status":"active"' && echo "PASS 开通成功" || echo "FAIL $RESP"
# 断言响应不含 hash / 明文密码
echo "$RESP" | grep -qE 'password_hash|TestPass' && echo "FAIL 密码泄漏" || echo "PASS 无密码泄漏"

# 3. 新 owner 登录
TENANT_ID=$(echo "$RESP" | sed -E 's/.*"id":"([^"]+)".*/\1/')
TTOK=$(curl -s -X POST localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"owner-$SLUG@qa.local\",\"password\":\"TestPass123!\",\"tenantSlug\":\"$SLUG\"}" \
  | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
[ -n "$TTOK" ] && echo "PASS owner 登录成功" || echo "FAIL owner 登录失败"

# 4. 新租户业务端点可用
curl -s -o /dev/null -w "GET /api/customers → %{http_code}\n" \
  -H "Authorization: Bearer $TTOK" localhost:3001/api/customers

# 5. 审计链验证
DATABASE_URL="postgresql://kirindesk:kirindesk_dev_password@localhost:5432/kirindesk_dev" \
  pnpm --filter @kirindesk/database verify-chain "tenant:$TENANT_ID"

# 6. slug 冲突 → 409
curl -s -o /dev/null -w "slug 冲突 → %{http_code}\n" \
  -X POST localhost:3001/api/platform/tenants \
  -H "Authorization: Bearer $PTOK" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Dup\",\"slug\":\"$SLUG\",\"ownerEmail\":\"dup@qa.local\",
       \"ownerPassword\":\"TestPass123!\",\"ownerName\":\"Dup\"}"

# 7. 租户 token 访问开通端点 → 401
ATOK=$(curl -s -X POST localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@dev.local","password":"dev-password-123","tenantSlug":"dev-tenant"}' \
  | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
curl -s -o /dev/null -w "租户 token 开通 → %{http_code}\n" \
  -X POST localhost:3001/api/platform/tenants \
  -H "Authorization: Bearer $ATOK" -H 'Content-Type: application/json' \
  -d '{"name":"x","slug":"x","ownerEmail":"x@x.com","ownerPassword":"12345678","ownerName":"x"}'
```

**链完整性（开通后 + 若干业务操作后）**

```bash
DATABASE_URL="postgresql://kirindesk:kirindesk_dev_password@localhost:5432/kirindesk_dev" \
  pnpm --filter @kirindesk/database verify-chain "tenant:<new_tenant_id>"
# 预期：Status: PASS，Total entries ≥ 1（含 tenant.created）
```

### 8.2 验收标准

以下各项**全部**满足方可标记本阶段完成并更新 CLAUDE.md §10：

**功能**
- [ ] `POST /api/platform/tenants`（platform token）→ 201，响应含 `tenant` + `owner`
      元信息，**无** `password_hash` / `ownerPassword`
- [ ] 三行原子落库：DB 中同时存在 `tenants` 行 + `users is_tenant_owner=true` 行 +
      `audit_log_chains chain_key='tenant:<id>'` genesis 行
- [ ] 新租户 owner 用 `{email, password, tenantSlug}` 登录 → 200 + accessToken（密码正确）
- [ ] 新租户业务端点（如 `GET /api/customers`）以 owner token 访问 → 200（非 500/403）
- [ ] `verify-chain tenant:<id>` → **PASS**（genesis 行存在且链可延伸）
- [ ] 开通审计 `tenant.created` 入链：`actor_type='platform_admin'`，metadata 含
      `tenantSlug` + `ownerEmail` + `ownerUserId`，**不含任何密码字段**
- [ ] slug 冲突 → 409，DB 无新行（事务回滚）
- [ ] slug 格式非法 / ownerPassword 过短 / 缺必填 / 多余字段 → 400
- [ ] 租户 token / 无 token 访问开通端点 → 401
- [ ] 平台控制台「开通租户」表单：成功后列表出现新租户行；slug 冲突内联报错不崩页

**安全 / 隐私**
- [ ] 响应体 `JSON.stringify` 不含 `password_hash` / 密码原文前缀（集成测试断言）
- [ ] DB 中 `password_hash` 以 `$2b$` 开头（bcrypt），不等于原文
- [ ] `audit_logs.metadata_json` 文本中不含密码任何形式
- [ ] 前端 `ownerPassword` 不落 localStorage / sessionStorage / URL（浏览器 QA spot-check）

**质量门**
- [ ] `pnpm verify` 全绿：lint / format / typecheck / build / unit / integration
      （≥ 289 + ~12 新用例）/ security 13/13
- [ ] 浏览器 QA 截图 ≥ 3 张留证
