# 队员路由细节

team-lead skill 的补充说明。遇到下面的情况时，查对应的一节。

| 遇到 | 看 |
| --- | --- |
| 要创建多位队员，或想把登记和创建写在同一步 | 同一步里登记和创建 |
| 看不懂结果末尾的 `member-model:` 行 | 结果末尾的 member-model: 行 |
| 汇报要列出各队员的实际路由 | applied：各队员的实际路由 |
| `list_agents` 显示的模型和结果行对不上 | list_agents 里的模型字段 |
| 被拒绝：`MEMBER_MODEL_ARM_REQUIRED` | 被要求先登记 |
| 创建失败 | 创建失败 |
| `arm_spawn_route` 返回 armed:false | 返回 armed:false |
| 要放弃这次登记 | clear_spawn_route |
| 省略思考强度、插件默认路由、requireArm 关闭 | 配置相关 |

## 规则

### 三个路由工具

- `arm_spawn_route`：为下一位 fresh 队员登记路由（provider、model、reasoningEffort），或登记 `{"follow": true}` 跟随队长。再次登记会替换上一次。
- `get_spawn_route`：查看 `pending`（尚未使用的登记）、`requireArm`、`activeDefault`（插件默认路由，只在插件配置 inherit=false 时出现），以及 `applied`（最近 16 位队员实际拿到的路由）。
- `clear_spawn_route`：清掉自己尚未使用的登记。

这三个工具只有顶层队长能看到，队员和子代理看不到。

### 登记只给紧接着的一次创建

- 登记只由该队长下一次 fresh `spawn_teammate` 使用。workflow 子代理、后台子代理和其他创建不会用掉登记，也不会被它改写。
- 一次只能登记一位。要创建多位 fresh 队员时，每位写成相邻的「登记 → 创建」一对，可以写在同一步里，见下一节。
- fork 不用掉登记，也不受登记影响。fork 时如果还有登记，结果会提示登记仍在，留给下一位 fresh 队员；不再需要时用 `clear_spawn_route` 清掉。

### 同一步里登记和创建

宿主把 `arm_spawn_route` 和 `spawn_teammate` 都当作独占调用：同一步里的调用按顺序逐个执行，前一个结束后下一个才开始。

- 正确写法：`arm A → spawn A → arm B → spawn B`。各队员拿到各自登记的路由。
- 错误写法：`arm A → arm B → spawn A → spawn B`。第二次登记会顶掉第一次，于是 A 拿到 B 的路由，B 被拒绝。
- 登记失败时（路由不可用，或返回 armed:false），同一步里紧随的创建会被拒绝（`MEMBER_MODEL_ARM_REQUIRED`），不会创建队员。改正登记后重新创建。
- 如果插件关闭了 requireArm，紧随的创建会改为跟随队长，结果行会注明。按「每次创建」第 3 步核对。

## 看结果

### 结果末尾的 member-model: 行

- `"名字" → provider/model · 强度 (armed route; verified on the live teammate)`：按登记创建，已在队员身上核实。
- `(armed follow, same as the lead; verified ...)`：按登记跟随队长，已核实与队长一致。
- `(plugin default route; ...)`：没有登记，使用插件默认路由（inherit=false）。
- `(nothing armed, follows the lead; requireArm is off; ...)`：插件关闭了 requireArm，没有登记的队员跟随队长。
- `(...; live teammate not found, unverified)`：找不到运行中的队员，显示的是计划路由，未核实。可以继续，但汇报时注明这位队员的路由未核实。
- `WARNING ...`：实际路由与计划不符，或者登记没有被这次创建使用。停止继续创建并告诉用户。
- `effort unset`：队员没有显式的思考强度，由 provider 决定。

### applied：各队员的实际路由

`get_spawn_route` 的 `applied` 按从旧到新的顺序，记录该队长最近 16 位队员的实际路由。

每条包括：`teammate`、`source`（armed、follow、default、explicit、inherit、not-applied）、`route` 和 `verified`。

最终汇报按 `applied` 列出各队员的实际路由。记录只保存在内存里：队长所在的 agent 被释放，或宿主重启后，记录都会清空。

### list_agents 里的模型字段

- `list_agents` 里不在运行的队员（例如刚重启、尚未恢复）显示的是队长的模型，不代表队员的路由。
- `spawn_teammate` 和 `list_agents` 返回的 `provider` 是创建方式（spawn 或 fork），不是模型供应商；`model` 只有模型名，不含供应商和思考强度。

核对完整路由，以 `member-model:` 行和 `applied` 为准。

## 出问题时

### 被要求先登记（MEMBER_MODEL_ARM_REQUIRED）

插件的 requireArm 开启（默认）时，顶层队长在没有登记、也没有插件默认路由的情况下创建 fresh 队员会被拒绝，队员没有被创建。按「每次创建」第 1 步登记后再创建。fork 不受影响。

### 创建失败

失败结果末尾的 `member-model:` 行会说明登记是否还在：

- `stays armed for a retry`：登记已恢复，可以用同一路由直接重试。
- `was cleared or replaced meanwhile and was not restored`：期间发生了 clear 或新的登记，旧登记不会恢复；重试前按需要重新登记。

放弃这次创建、改派给已有队员或改用 fork 时，调用 `clear_spawn_route`，避免下一位 fresh 队员误用这次登记。

### 返回 armed:false

登记在预检期间被并发的 clear 或另一次登记越过，这次没有登记成功。这只在调用互相重叠时出现，例如由代码并行发起的调用；逐个调用，或在同一步里成对写时，都不会出现。

遇到时先用 `get_spawn_route` 核对，再按意图重新登记；不能当作已登记而直接创建。

### clear_spawn_route

- 只清调用者自己的未用登记；不修改插件默认路由；不取消已经开始的创建。
- 返回 cleared:false 也有效：它会阻止更早的登记或失败恢复重新挂回旧路由。

## 配置相关

### 思考强度

登记时省略 reasoningEffort，结果取决于宿主：provider 和 model 与队长相同时，队员沿用队长的强度；换了路由时不设置强度，由 provider 决定。要使用用户指定的强度，就显式传入。

### 插件默认路由（activeDefault）

插件配置 inherit=false 并填写 provider、model 时，没有登记的 fresh 队员使用这条路由，这时 requireArm 不拦截；登记（包括 follow）优先于它。

它也用于没有写明模型的其他 fresh 子代理；写明了模型的请求不会被改写。

本 skill 的默认路由写在 SKILL.md 里，插件不读取。

### requireArm 关闭时

插件配置 requireArm=false 时，没有登记的 fresh 队员直接跟随队长，结果行会注明。仍建议每次登记，路由更可预期。
