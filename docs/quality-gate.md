# KirinDesk 质量门禁

本门禁用于阶段 1 及后续开发。它只使用隔离的测试数据库、Redis DB 1 和本地 MinIO，不部署、不发布，也不读取生产凭据或客户数据。

## 环境要求

- Node.js 20 或更高版本
- pnpm 9.15.4
- Docker 与 Docker Compose
- 首次运行浏览器测试前执行 `pnpm exec playwright install chromium`

启动基础设施：

```bash
docker compose up -d --wait postgres redis minio
docker compose run --rm minio-init
```

默认服务使用 PostgreSQL 5432、Redis 6379、MinIO 9000/9001。端口冲突时可用 `POSTGRES_PORT`、`REDIS_PORT`、`S3_PORT` 和 `S3_CONSOLE_PORT` 覆盖。

## 命令

| 命令 | 真实执行内容 |
| --- | --- |
| `pnpm verify:fast` | 所有活动 workspace 的 lint、格式、typecheck、build、unit test，以及 production dependency audit |
| `pnpm test:integration` | 重建 `kirindesk_test`、执行全部迁移并运行 API 集成测试 |
| `pnpm verify:migrations` | 在 `kirindesk_test` 回滚最近两份迁移，再按原校验和前滚恢复 |
| `pnpm test:security` | 启动失败策略、非超级用户运行、审计权限、RLS、会话和配额静态回归 |
| `pnpm test:e2e` | Chromium 下的租户/平台登录面与匿名路由回归 |
| `pnpm verify:full` | 依次执行以上完整门禁 |

本地完整门禁需要显式提供测试连接串。Redis URL 必须指向 DB 1；集成 setup 会拒绝并且不会清空其他 Redis DB。

```bash
export TEST_DATABASE_URL=postgresql://kirindesk:kirindesk_dev_password@127.0.0.1:5432/kirindesk_test
export TEST_APP_DATABASE_URL=postgresql://kirindesk_app:kirindesk_app_dev_password@127.0.0.1:5432/kirindesk_test
export APP_DB_PASSWORD=kirindesk_app_dev_password
export REDIS_URL=redis://127.0.0.1:6379/1
pnpm verify:full
```

## 数据安全边界

- 集成测试在任何写入前断言数据库名必须是 `kirindesk_test`。
- 迁移往返演练拒绝任何非 `kirindesk_test` 数据库。
- Redis 清理拒绝 DB 0 和任何非 DB 1 地址。
- API 运行时只读取 `APP_DATABASE_URL`，安全回归证明超级用户连接会导致启动失败。
- CI 中的数据库、JWT、Redis 和 MinIO 凭据均为一次性测试值。
- 门禁不启动生产部署，不推送分支，不创建发布标签。

## CI

`.github/workflows/quality-gate.yml` 在 PR 和非 `main` 分支 push 上运行完整门禁：

1. 使用 Node.js 22 与 pnpm 9.15.4 安装锁定依赖。
2. 安装锁文件对应的 Chromium。
3. 启动固定版本 PostgreSQL、Redis、MinIO，并初始化测试 bucket。
4. 执行 `pnpm verify:full`。
5. 无论成功或失败都输出基础设施日志，不部署任何环境。

## 依赖审计例外

`pnpm audit:prod` 会解析 `pnpm audit --prod --json`，对每条 high/critical 通告执行失败关闭。例外必须记录包名、不可利用证据、责任人、到期日和移除条件；缺字段或过期都会使门禁失败。当前例外见 `docs/dependency-audit-exceptions.json`。
