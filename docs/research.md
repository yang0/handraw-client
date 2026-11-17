# 竞品调研：AI 生图与创作工具（2026-11）

目的：找出值得借鉴的交互，用于手绘风生图工作台的设计。每条只记录和本产品有关的部分。

## 1. 逐个产品

### Midjourney（网页版）
- **Explore**：社区作品按 For You / Hot / Top（日、周、月）/ Random 浏览；For You 根据用户的个性化档案推荐。悬停作品可以直接「用这张图」「用这条提示词」「找相似」「点赞」。[来源](https://docs.midjourney.com/hc/en-us/articles/33329460426765-Website-Overview)
- **Style Explorer**：用图片浏览风格代码（sref），点一下就能用。
- **Moodboard / 个性化档案**：用户挑选喜欢的图形成个人偏好，可以多个混合。[来源](https://alpha.midjourney.com/updates/describe-on-web-moodboard-blending)
- **Describe**：拖入一张图，得到 4 条描述它的提示词。
- 借鉴：社区浏览的悬停快捷操作；「看图找风格」；个人偏好档案。

### Recraft
- **自定义风格**：上传 1 张或多张参考图即可建立风格，不需要训练；每张参考图可调权重；可以从画布或历史中直接选图。[来源](https://recraft.mintlify.dev/docs/recraft-studio/styles/custom-styles/how-to-create-a-custom-style)
- 风格可分享给团队，配合**品牌调色板**、Frames、Mockups 保证一系列图风格一致。[来源](https://www.recraft.ai/blog/new-tools-for-brand-style-consistency-and-control)
- 借鉴：从参考图创建画风的流程、参考权重、风格分享。

### Krea
- **Realtime**：画布上画几笔、写几个字，右侧结果实时更新，没有排队和生成按钮。[来源](https://www.krea.ai/docs/es/user-guide/features/realtime)
- **Training**：用自己的图训练风格或角色模型，保证长期项目一致。[来源](https://www.krea.ai/docs/user-guide/features/training)
- 借鉴：「即时反馈」的感觉。本产品用付费模型不适合每笔都生成，可以用本地示例图做零成本的即时预览。

### Lovart（设计 Agent）
- **ChatCanvas**：在图上任意位置点击加批注（「字小一点」「换背景」），一次最多 20 条，点「Run All」一起执行。画布按 Frame 组织，每个 Frame 有独立上下文。[来源](https://www.sohu.com/a/1081922273_413980)
- 可以把多张图里的元素（图 1 的 logo、图 2 的主体、图 3 的质感）组合成新图。
- 借鉴：批注式改图、Frame 分组。

### FLORA / FAUNA、Figma Weave、Freepik Spaces（节点画布）
- 无限画布 + 节点：文本节点、图像生成节点、助手节点、放大节点、导入/导出节点，连线成工作流，可以分享给他人复用。[Flora](https://itbrief.ie/story/flora-launches-fauna-for-creative-teams-with-usd-52-million) · [Weave](https://help.weavy.ai/en/articles/12268300-helpers-overview) · [Freepik Spaces](https://kr.freepik.com/spaces)
- FAUNA 会根据用户需求自动搭建节点工作流，用户看着它连线、执行，可以中途调整。
- 借鉴：工作流模板、助手自动搭流程、导出节点。

### Ideogram
- **Magic Prompt** 把简短想法扩写成详细提示词；Canvas 支持局部重绘（Magic Fill）和扩图（Extend）；Pro 版支持上传 CSV 一次批量生成最多 500 张。[来源](https://dataconomy.com/tools/ideogram/)
- 借鉴：表格批量生成；局部重绘和扩图。

### Invoke（桌面 / 自部署）
- 统一画布 + 图层：局部重绘蒙版、参考图层、控制层在同一画布中；有查看器切换快捷键。[来源](http://invoke.ai/releases/version/v6-0-0...latest/)
- 借鉴：图层化的改图画布。

### Draw Things / Local Code（Mac 本地）
- 全部在本机完成，不需要登录、API Key，内置模型选择器。[来源](https://releases.drawthings.ai/p/local-code-by-draw-things-open-source)
- 借鉴：本地优先、离线可用、模型选择器的组织方式。

### Raycast、Linear、Figma（效率工具交互）
- ⌘K 命令面板、全键盘操作、不弹多余确认而提供撤销、信息密度高。[来源](https://github.com/synthetic-recon/synthetic-skills/blob/main/product-design/references/power-user-patterns.md)
- 借鉴：命令面板、全局快捷键唤起的悬浮输入条。

## 2. 结论：本产品的机会

1. **资源库是核心优势。** 别人的风格是一串代码或一个模型，本产品有 370 种有编号、有特征说明、有示例图的画风，170 种图型，以及主题色和影调。应该把「浏览和挑选风格」做成产品里最好玩的部分，而不是一个下拉框。
2. **示例图可以提供零成本的即时预览。** 每个画风都有示例图，选择画风时不必生成就能看到效果，组合时可以并排比较。
3. **中文内容场景明确。** 公众号封面和配图、小红书多图、知识卡片、漫画分镜。可以做成场景模板，一键得到一整套图。
4. **本地 + 云双轨。** 图片默认留在本地，余额、资源、作品和网站同步。和 Draw Things 一样离线可用，又有 Midjourney 那样的社区。
5. **批注改图、命令面板、节点画布**都已被验证，适合直接采用。
