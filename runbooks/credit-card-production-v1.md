# AIstory 管理员积分卡 v1 生产交接（默认关闭）

本候选只建立管理员生成、显式激活、用户一次性兑换和现有账本原子记账的安全合同。应用 migration 或发布代码不会自动启用功能、生成卡、赠分、发送短信、连接模型或修改余额快照。

## 固定边界

- 普通新注册用户首赠保持 **1,000 credits**。forward gate 会验证 `billing_policies.initial_grant_credits = 1000`；不迁移、补发或改写既有用户。
- `fixed_beta_credit_v1` 保持 disabled/superseded，不由积分卡功能启用。
- 卡号、PIN、批次激活 token 由应用服务器的加密安全随机源生成。数据库只保存域分隔 HMAC-SHA-256；不保存明文、掩码、后缀或可枚举提示。
- 生成成功的首次响应是唯一一次明文交付。幂等重放只返回安全批次摘要，不再次显示卡密。批次在管理员使用一次性 token 显式激活前不可兑换。
- 兑换只接受现有、有效、已验证 phone stable UUID；不会读取或记录手机号。积分以 `credit_ledger(kind='reward')` 原子追加，余额由账本求和，不更新 `balance_snapshot`，不建立第二账本。
- 管理员必须是 P0.5 独立 principal 的有效、未撤销会话。legacy Supabase admin、本地管理员及普通手机号身份不能生成或管理积分卡。

## Root-only 配置合同（只列变量名）

由 root 运维仅写入生产服务环境文件 `/etc/aistory/iy.env`：

- `AISTORY_CREDIT_CARD_MODE=production_v1`
- `AISTORY_CREDIT_CARD_CONFIG_FILE=<checkout 外绝对路径>`
- `AISTORY_CREDIT_CARD_DATABASE_GATE_VERSION=20260828234500`
- `AISTORY_CREDIT_CARD_PUBLIC_ORIGIN=<精确 HTTPS 根 origin>`

本功能还要求 P0.5 独立管理员和 Gate14 的既有 root-only 变量全部通过，不能用本段替换它们。不得把任何值写入 `.env.example`、Git、浏览器、日志、截图、聊天或 AIShare。

`AISTORY_CREDIT_CARD_CONFIG_FILE` 指向 checkout 外的 root:root `0600` regular file；硬链接数必须为 1，禁止 symlink/junction/reparse。UTF-8 JSON 必须是以下 exact shape（占位符不是可部署值）：

```json
{
  "schemaVersion": "aistory.credit-card-runtime.v1",
  "policyVersion": "credit-card-policy-v1.<reviewed-version>",
  "keyId": "cck_<reviewed-id>",
  "hmacKeyBase64url": "<32-to-96-random-bytes-base64url>",
  "allowedDenominations": ["<reviewed-positive-integers-sorted-unique>"],
  "allowedValidityDays": ["<reviewed-positive-integers-sorted-unique>"],
  "maxBatchCount": "<reviewed-positive-integer>",
  "maxBatchCredits": "<reviewed-positive-integer>"
}
```

真实 JSON 中上述四个数值字段/数组元素必须是 JSON integer，而非字符串。代码硬上限只是安全上限，不是 Founder 业务批准：面额不超过 1,000,000，单批不超过 100 张/10,000,000 credits，有效期不超过 365 天。生产启用前仍须 Founder 明确批准实际面额、数量、有效期、总负债预算及 key 轮换周期。

## Staging 顺序

1. 对获准 source manifest 逐文件复算 bytes/SHA；frozen lockfile install，完成 canonical build 与现有 P0.5/phone/account/billing 回归。
2. 备份并只在 staging apply `20260828234500_credit_card_gate.sql`。确认 Gate14 与 P0.5 gate/posture 先通过，migration identity 与发布 manifest 完全一致。
3. 保持四个积分卡变量未配置，验证管理员和用户 API 均固定 503，普通注册/登录/1000 首赠及公共只读浏览不受影响。
4. 以 staging 专用 root-only 配置和专用随机 HMAC key 启用。验证：独立管理员会话、生成 pending 批次、幂等重放不重显、显式激活、单张兑换、同 key replay、并发双兑、错 PIN/猜号/过期/禁用/限流、账本 reward 与安全 audit。
5. 验证卡密未进入 access/error log、浏览器 storage、URL、audit、DB 行、监控或截图。测试卡完成后禁用整个 staging 批次并销毁 staging key。

## Production 发布门禁

- Founder 书面批准实际 policy 数值与最大负债；security review 明确接受“一次性首次响应”的操作流程。
- source/lockfile/migration hash、frozen install、canonical build、focused tests 与 staging RPC/RLS/GRANT/并发测试全部 PASS。
- migration apply 后，先在配置仍 disabled 时重启唯一 `aistory-iy` 实例并检查 gate；禁止多个 registry/card writer。
- 仅由 root 创建 owner-only config，原子写入服务环境引用，重启 `aistory-iy`。不得从管理员浏览器配置 HMAC key。
- 先批准一个最小面额、数量 1 的受控生产 smoke；生成后先保存一次性卡密，再激活和兑换。核对 ledger/audit 后才允许管理员生成其他批次。
- P0.5 staging/prod switch、session rotation、CSRF/same-origin、rate limit、Gate14 任一不 PASS 时，禁止初始化卡或启用变量。

## 回滚与事故处理

应用回滚优先把 `AISTORY_CREDIT_CARD_MODE` 移除/改为非受支持值并重启 `aistory-iy`，使路由 fail-closed；随后由已认证管理员在旧版本仍可用时禁用全部未兑换批次。不要回退 migration，不删除账本、redemption 或 audit 行，不直接更新余额。

若首次生成响应丢失，幂等重放绝不恢复明文；该 `pending_activation` 批次必须禁用并新建。若 key 疑似泄露，立即关闭 runtime、禁用所有 pending/active 批次、保留审计并按独立 break-glass 流程发布新 `keyId`/binding；有未禁用批次时 database key-binding gate 会阻止静默换 key。
