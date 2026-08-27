# ADR-0002：单 SQLite 双用户字段隔离

- 状态：Accepted
- 日期：2026-08-18

## 背景

Client 内置两个本地用户，需要隔离会话、模型、Skill、凭据引用、附件和运行历史。两个用户属于同一操作系统账号下的应用身份，不是强认证租户。

## 决策

- 使用一个 SQLite 文件和同一套表。
- 所有用户私有表包含 `user_id NOT NULL`。
- 所有业务 Repository 显式接收 User Context。
- 父子关系使用 `(user_id, id)` 复合唯一键与复合外键。
- 常用索引以 user_id 开头。
- Credential Store namespace 同样包含 userId。

## 理由

- 部署、迁移、备份和诊断简单。
- 两个本地用户规模不需要独立数据库的运维复杂度。
- 通过 Schema、Repository 和负向测试可以建立足够的应用级隔离。

## 影响

- SQLite 没有原生行级安全，漏写 scope 是高风险缺陷。
- 禁止面向业务提供无 userId 的 getById/findAll。
- 不宣称能够抵御本机文件读取或进程调试。

## 未采用

- 每个用户独立 SQLite 文件。
- 仅依赖全局唯一 ID 而不写 user_id。
- 将两个用户当作云端认证租户。
