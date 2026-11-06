# Hunter Agent

给 JsMacros 用的 Minecraft 挂机脚本。它会在指定的家里打怪、接精英任务、背包满了出售并存进 ME、精英币够了就升级。公屏有人说「停止挂机」时，会停 30 分钟。

打怪靠 Baritone 走过去，贴近后交给身上的荆棘和 Kill Aura。Y 轴差太大的怪不追，另一层另设一个家。

## 准备

- 带 JsMacros 的客户端
- Baritone
- 服务器上的家、任务 NPC 命令、出售和升级命令，按自己的服改 `Macros/hunter-agent/config.ts`

## 配置密码

```bash
cp .env.sample .env
```

在 `.env` 里填写：

```bash
LOGIN_PASSWORD=你的登录密码
```

脚本从仓库根目录读这个文件。`.env` 不要提交。

## 运行

在 `Macros` 目录打包：

```bash
node scripts/bundle-hunter.js
```

然后用 JsMacros 运行 `Macros/hunter-agent/index.ts`。

改了 `Macros/hunter-agent` 里的源码之后，要重新打包再运行。

## 任务和家

`config.ts` 里的 `questRoutes` 每一张任务有名字和家。名字要和任务面板上的文字对得上。

没接的任务是绿色玻璃板，按名字点。接上之后会挪到最前面，变成别的颜色的玻璃板。放弃和交付都点这块已经接上的玻璃。

这一轮家都没有怪，而且进度还没到八成，就放弃并换下一张。快打完才留在原地等。

## 公屏暂停

任何人在公屏发出「停止挂机」，脚本会停下寻路和任务，30 分钟后再继续。
