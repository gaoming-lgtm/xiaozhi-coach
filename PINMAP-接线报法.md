# 接线报法（用户指定，2026-11-03）

用户原话：**"后面接线你说哪侧数字几就行"**。

> 配图：`docs/01-pinmap.png`（引脚全图）· `docs/02-mic-pins.png`（麦克风六针）·
> `docs/03-breadboard-rule.png`（横着通、竖着不通）· `docs/04-breadboard-zones.png`（五个区域）·
> `docs/05-plug-in.png`（插到底 vs 歪着搭）

## 报法约定

格式：`<排>·<序号>`

- **排**：`3V3 排`（有 3V3 和 RST 的那一排） / `TX 排`（有 TX、RX、41/42 的那一排）
- **序号**：**从模块那头（金属屏蔽罩 / 天线端）往 USB 方向数**，模块端 = 1

这样报的目的：板子插进面包板后朝向会翻，但"模块端第 N 个"永远不变。

## 两排完整顺序

3V3 排（模块端 → USB 端）：
1 3V3 / 2 3V3 / 3 RST / **4 GPIO4** / **5 GPIO5** / **6 GPIO6** / **7 GPIO7** /
**8 GPIO15** / **9 GPIO16** / 10 GPIO17 / 11 GPIO18 / 12 GPIO8 / 13 GPIO3 / 14 GPIO46 /
15 GPIO9 / 16 GPIO10 / 17 GPIO11 / 18 GPIO12 / 19 GPIO13 / 20 GPIO14 / 21 5Vin / 22 GND

TX 排（模块端 → USB 端）：
1 GND / 2 TX / 3 RX / 4 GPIO1 / 5 GPIO2 / **6 GPIO42** / **7 GPIO41** / 8 GPIO40 /
9 GPIO39 / 10 GPIO38 / 11 GPIO37 / 12 GPIO36 / 13 GPIO35 / 14 GPIO0 / 15 GPIO45 /
16 GPIO48 / 17 GPIO47 / 18 GPIO21 / 19 GPIO20 / 20 GPIO19 / 21 GND / 22 GND

> 注意：**42 在 41 上面**（42 = TX 排·6，41 = TX 排·7）。

## 本套接线速查（8 个信号 + 电源）

| 信号 | 位置 | 备注 |
|---|---|---|
| INMP441 WS | 3V3 排·4 | GPIO4 |
| INMP441 SCK | 3V3 排·5 | GPIO5 |
| INMP441 SD | 3V3 排·6 | GPIO6 |
| MAX98357A DIN | 3V3 排·7 | GPIO7 |
| MAX98357A BCLK | 3V3 排·8 | GPIO15 |
| MAX98357A LRC | 3V3 排·9 | GPIO16 |
| OLED SDA | TX 排·7 | GPIO41 |
| OLED SCL | TX 排·6 | GPIO42 |
| 3V3 供电 | 3V3 排·1 或 ·2 | 引到面包板 + 轨 |
| GND | 3V3 排·22、TX 排·21/22/1 | 引到 − 轨 |

引脚地图图：`_insp/pinmap.png`
