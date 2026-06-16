# Phase 1G — AI/OCR 模块规划

## 1. 目标与范围

本阶段为 KirinDesk 引入 AI/OCR 能力的基础骨架，遵循 CLAUDE.md §7 Provider Abstraction Rules：

- **Provider 接口**：定义统一的 AI/OCR provider 接口（如 `OcrProvider` / `AiProvider`），所有调用方依赖接口而非具体厂商实现，便于后续替换。
- **Mock 实现**：仅提供 mock / 占位 provider 实现，返回可预测的假数据，用于本地开发与测试，不触达任何外部网络。
- **OCR 调用审计**：每一次 AI/OCR 调用（无论成功或失败）须可审计，记录调用方、租户、资源、provider、耗时与结果状态，写入 append-only 审计链（CLAUDE.md §6）。

**明确不做（本阶段范围外）**：

- 不接入真实的 DeepSeek、OpenAI、或任何商用 OCR 服务（CLAUDE.md §7 要求接真实厂商前须经批准）。
- 不创建或使用任何真实厂商密钥 / API key（CLAUDE.md §8）。
- 不发起任何向第三方传输客户业务数据的网络请求。

本阶段交付一个可工作、可测试、完全本地化的 AI/OCR 抽象层，为后续接入真实 provider 预留干净的插槽。

## 2. 数据库变更

**结论：本阶段优先复用既有表，预计不新增业务表。**

### 2.1 复用既有 `provider_invocations`（migration 020 + RLS 021）

Phase 0 已建好 `provider_invocations` 表，专用于记录 provider 调用，且当前代码尚未写入任何行。其列已覆盖本阶段 OCR/AI 调用审计的核心需求：

| 列 | 类型 | 本阶段用途 |
| --- | --- | --- |
| `id` | uuid PK | 调用记录主键 |
| `tenant_id` | uuid NOT NULL → tenants | 租户隔离（RLS 主键） |
| `provider_type` | varchar(30) | `'ocr'` / `'ai'` |
| `provider_name` | varchar(50) | 具体实现名，本阶段固定为 `'mock'` |
| `action` | varchar(100) | 调用动作，如 `'ocr.extract'` |
| `request_json` | jsonb | 入参摘要（**不落客户文件原文/敏感字段**，见 §5） |
| `response_json` | jsonb | 结果摘要 |
| `status` | varchar(20) | `'success'` / `'error'` |
| `duration_ms` | integer | 调用耗时 |
| `tokens_used` | integer | 预留，mock 阶段可空 |
| `cost_estimate` | decimal(10,4) | 预留，mock 阶段可空 |
| `invoked_by` | uuid NOT NULL | 调用方 user id（审计主体） |
| `created_at` | timestamptz | 调用时间 |

`provider_invocations` 已具备 `tenant_isolation_policy`（ENABLE + FORCE ROW LEVEL SECURITY，migration 021），与其它租户业务表一致，无需新增 RLS。

### 2.2 tenant_id 用法

所有写入均带 `tenant_id`，并在租户上下文事务内执行，RLS 在数据库层强制隔离，应用层不得跨租户读写调用记录。

### 2.3 索引

复用既有索引，无新增：

- `idx_provider_invocations_tenant_type (tenant_id, provider_type)`
- `idx_provider_invocations_created (created_at)`
- `idx_provider_invocations_status (status)`

### 2.4 软删除策略

调用记录属审计性质（append-only 倾向），本阶段**不提供软删除、也不提供更新/删除入口**；仅 INSERT + SELECT。是否对该表收紧为 SELECT,INSERT-only grant（对齐 §6 审计原则），在 §6 权限小节确认后于实现时通过迁移补授权，不在本节预先改动。

### 2.5 是否需要补充列 / 新迁移

核心需求已被覆盖，**本阶段倾向零迁移**。仅在实现期发现以下任一缺口时，才新增一支**纯加列、可逆**的迁移（不改既有列、不破坏已落数据）：

- 需关联触发调用的源文件（`files.id`）以建立「文件 → OCR 结果」可追溯链 —— 候选新增可空列 `source_file_id uuid`（不加硬 FK，或加 `ON DELETE SET NULL`，避免删文件级联影响审计记录）。
- 需收紧上表写入授权（见 §2.4 / §6）。

任何迁移在创建前仍须按 CLAUDE.md §5 单独列出表/列、tenant_id、RLS、索引、软删除、审计、回滚后再经批准，不在本规划内擅自落地。

### 2.6 回滚策略

- 若本阶段最终零迁移：无数据库回滚动作，回滚仅涉及代码层 provider/接口的移除。
- 若新增加列迁移：提供对应 `-- DOWN`（`DROP COLUMN` / `REVOKE`），且因均为加列/授权调整，回滚不丢失既有 `provider_invocations` 数据。

## 3. Provider 接口设计

_待补充_

## 4. Mock 实现

_待补充_

## 5. 审计要求

_待补充_

## 6. RBAC / 权限

_待补充_

## 7. API 端点

_待补充_

## 8. 风险与回滚

_待补充_

## 9. 验证命令与验收标准

_待补充_
