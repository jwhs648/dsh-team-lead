# member-model 实机验收清单

在真实 DSH 宿主上验证 member-model 与 team-lead skill。用于：发布新版本前，或 `scripts/kernel-check.mjs` 对新 DSH 版本全部 PASS 之后、放宽 peerDependencies 之前。

隔离测试（`npm test`）和 kernel-check 都不调用真实模型，不能代替这份清单。

## 准备

- [ ] 记录版本：DSH 桌面版或 CLI 版本、内核版本（`@deepseek-ai/dsh`）、member-model 版本、profile 名。
- [ ] 备份将要改动的 profile 目录，以及 `~/.dsh/skills/team-lead/`（Windows：`%USERPROFILE%\.dsh\skills\team-lead\`）。
- [ ] 准备两条用户已授权的路由：A（skill 的默认路由）和 B（另一条 provider/model/思考强度组合）。记下队长当前的路由 L。
- [ ] 使用启用了 Agent Teams 的会话。验收过程创建的队员名字不要重复，例如 `check-a`、`check-b`……

## 1. 安装与加载

- [ ] 用 `plugin_manager` 的 `install_bundle` 安装或升级（CLI 为备选）。记录结果里的 `application`：
  - 首次安装且 profile 支持热加载：`applied`，无需重启。
  - 升级已安装的 bundle，或 profile 不支持热加载：`restart-required`，重启宿主后再继续。
- [ ] `plugin_manager` 的 `list_bundles` 里 member-model 为 1.2.0 且已启用。
- [ ] 插件列表显示标题「队员模型」（英文界面为 Member Model）、说明文字和图标。
- [ ] 运行已安装包里的 `node scripts/sync-skill.mjs` 预览：应识别出现有副本的模板版本，并读出你的三项默认路由。
- [ ] 加 `--write` 写入：`SKILL.md` 和 `references/` 更新，三项默认路由不变，`<skill 目录>/.backup/` 下有旧文件备份。

## 2. 工具可见性（D）

- [ ] 队长能看到并调用 `get_spawn_route`，返回里有 `requireArm: true`。
- [ ] 让一位已创建的队员尝试调用 `get_spawn_route`：应提示工具不存在或不可用，队员的工具列表里没有这三个路由工具。

## 3. 未登记拦截（C2）

- [ ] 不登记，直接 `spawn_teammate`（fresh）：返回错误，包含 `MEMBER_MODEL_ARM_REQUIRED` 和登记提示。
- [ ] `list_agents` 里没有因此多出成员。
- [ ] 不登记，`spawn_teammate`（fork）：正常创建，不被拦截。

## 4. 登记与结果核对（A、B）

- [ ] 登记 A（写明强度）后创建 fresh 队员：结果末尾有 `member-model: "名字" → A · 强度 (armed route; verified on the live teammate).`
- [ ] `get_spawn_route`：`pending` 已消失；`applied` 的最后一条为 `source: "armed"`、`verified: true`，route 与 A 一致。
- [ ] 登记 `{"follow": true}` 后创建 fresh 队员：结果行为 `armed follow, same as the lead`，路由与 L 一致。
- [ ] 登记 B 但不写强度：结果行的强度与宿主规则一致（B 与 L 的 provider/model 不同时显示 `effort unset`）。
- [ ] 在界面或 `list_agents` 中确认新队员的模型名与结果行一致。
- [ ] `get_spawn_route` 的 `applied` 按创建顺序列出刚才几位队员。
- [ ] 在同一步里写两对「arm → spawn」：两位队员各自拿到登记的路由。

## 5. 登记只给建队员（A）

仅在当前 profile 或预设启用了 workflow（或其他会创建 fresh 子代理的功能）时执行。

- [ ] 登记 B，然后让队长运行一次显式指定模型 C 的 workflow `agent()`：该子代理使用 C，不被 B 改写。
- [ ] `get_spawn_route` 中 `pending` 仍是 B；随后创建 fresh 队员，结果行为 B。

## 6. fork、失败与清除

- [ ] 登记 A 后创建 fork 队员：结果提示 A 仍在，留给下一位 fresh 队员；`pending` 仍是 A。
- [ ] 保持登记，用已经用过的名字创建 fresh 队员：创建失败，结果行说明 `stays armed for a retry`，`pending` 仍在。
- [ ] `clear_spawn_route`：返回 `cleared: true` 和路由；再调用一次返回 `cleared: false`。

## 7. 重启与恢复

- [ ] 重启宿主后，已有队员恢复运行时仍使用创建时的路由（可让队员执行一个小任务，在界面中核对模型）。
- [ ] 记录重启后、队员恢复前 `list_agents` 显示的模型（references 中说明过：此时可能显示队长的模型）。

## 8. skill 行为抽查

用 `/team-lead <任务>` 发起一次真实的组队任务，观察队长：

- [ ] 组队前确认了前提（有 `spawn_teammate`，有支持 `follow` 的 `arm_spawn_route`）。
- [ ] 拆分时，工作块较多或有依赖的情况下，先建了任务板任务，并在开场任务里写明哪个任务归谁。队员开工先认领自己的任务，队长没有再 reassign 同一个任务。
- [ ] 登记和创建是成对的（同一步或逐步都可以），没有出现先连续登记、再连续创建。
- [ ] 每位 fresh 队员创建前都先登记，且登记后紧接着创建；创建后核对了 `member-model:` 行。
- [ ] 打开一位队员的会话：开场任务末尾附有完整的「协作要求」块，并写明临时文件和报告文件放在哪里。
- [ ] 如果用了 fork：开场任务仍写清了当前任务（fork 看不到队长当前这一轮）。
- [ ] 队员遇到需要决定的问题时，用 `send_message` 联系 lead，并继续做不受影响的部分；回报先写结论，大段内容给了文件路径。
- [ ] 队长在所有必要队员完成并验收后才给最终答复。汇报前调用了 `get_spawn_route`，并按 `applied` 列出各队员负责的部分和实际路由。
- [ ] （可选）在没装 member-model 的 profile 里发起组队：队长先告诉你插件不可用，没有直接让队员跟随队长。

## 9. 停用与收尾

- [ ] `set_bundle` 停用 member-model：三个路由工具消失，`spawn_teammate` 不再被拦截。重新启用后恢复。
- [ ] 删除或保留验收用队员，按需要恢复备份，确认用户的默认路由与其他本地配置未被改动。

## 记录

| 项目 | 结果 | 备注 |
| --- | --- | --- |
| DSH / 内核版本 | | |
| 1 安装与加载 | | |
| 2 工具可见性 | | |
| 3 未登记拦截 | | |
| 4 登记与结果核对 | | |
| 5 登记只给建队员 | | |
| 6 fork、失败与清除 | | |
| 7 重启与恢复 | | |
| 8 skill 行为抽查 | | |
| 9 停用与收尾 | | |
