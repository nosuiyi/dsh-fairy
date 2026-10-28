# 本机 TTS 环境（GPT-SoVITS v2）安装记录

一次装完的完整记录，便于重装或换机复现。

## 位置

| 项 | 路径 |
|---|---|
| 仓库 + venv + 模型 | `B:\WND\study\Github\GPT-SoVITS`（约 9 GB） |
| Python 3.10 | `C:\Users\Proud\AppData\Roaming\uv\python\cpython-3.10-windows-x86_64-none\python.exe`（uv 托管，不动系统 Python） |
| 参考音频 | `B:\WND\study\Github\GPT-SoVITS\refs\fairy_ref.wav`（5.62 秒 / 48 kHz 单声道） |
| Fairy 权重 | `B:\WND\study\Github\GPT-SoVITS\GPT_SoVITS\pretrained_models\fairy\{Fairy-e10.ckpt, Fairy_e10_s870.pth}` |
| 服务日志 | `_dl\api.out` / `_dl\api.err` |

## 步骤

```powershell
# 1) Python 3.10（uv 托管）
python -m pip install uv
python -m uv python install 3.10

# 2) 克隆
cd B:\WND\study\Github
git clone --depth 1 https://github.com/RVC-Boss/GPT-SoVITS.git

# 3) venv
cd GPT-SoVITS
python -m uv venv --python 3.10 --seed .venv

# 4) torch（见下方「为什么是 2.8」）
.\.venv\Scripts\python.exe -m pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu126

# 5) 依赖
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip install resampy      # requirements 里没有，合成时才报缺

# 6) 前置模型（4.35 GB）
#    https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/{pretrained_models,G2PWModel,nltk_data}.zip
#    pretrained_models.zip → 解压到 GPT_SoVITS/
#    G2PWModel.zip         → 解压到 GPT_SoVITS/text/
#    nltk_data.zip         → 解压到 .venv/
#    open_jtalk_dic_utf_8-1.11.tar.gz → 解压到 .venv/Lib/site-packages/pyopenjtalk/

# 7) 配置 GPT_SoVITS/configs/tts_infer.yaml 的 custom 段
#    t2s_weights_path:  .../fairy/Fairy-e10.ckpt
#    vits_weights_path: .../fairy/Fairy_e10_s870.pth
#    version: v2  device: cuda  is_half: true

# 8) 起服务
.\.venv\Scripts\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

## 踩到的坑（都已解决）

| 坑 | 现象 | 处理 |
|---|---|---|
| **torch 版本** | 先装到 2.14.1+cu126，`torchaudio.load` 报 `TorchCodec is required`；装 torchcodec 后 `libtorchcodec_core4.dll` 加载失败（缺依赖 DLL） | 降到 **torch 2.8.0 + torchaudio 2.8.0**（cu126），回到 soundfile 后端，不再需要 torchcodec |
| **中文路径** | libsndfile 打不开 `了解我会如同主人…wav`（`System error`） | 参考音频复制成 ASCII 路径 `refs/fairy_ref.wav` |
| `resampy` 缺失 | 合成请求 400：`No module named 'resampy'` | `pip install resampy` |
| VITS 权重 `missing_keys` | 加载 `Fairy_e10_s870.pth` 时列出大量 `enc_q.*` 缺失 | **正常**：`enc_q` 是训练期的后验编码器，推理不需要 |

原文档（`docs/TUTORIAL.md` §6.2）提到的另外三个坑这次没触发：本机有编译器，`jieba_fast`、`opencc` 都直接编译成功；`transformers` 已由仓库限定 `<5`。

## 实测

- 6 GB 显存：模型常驻后占用约 **5.0 GB / 6.1 GB**，未 OOM。
- 单条合成：首次 6.9 秒（含预热），之后约 2–4 秒。
- 语音时长：3.74–5.14 秒/条（比 Edge-TTS 版短 10% 左右，语速更接近原声）。
- 请求参数用 `text_split_method: cut0`（整句不切）；切分合成会改变音色。

## 版权

权重由《绝区零》游戏语音训练而来，原作者明确「数据集不能商用」「严禁商用」。
**仅限本机自用**：生成的 wav 只放 `~\.dsh\hdd-fairy\assets\`，不进仓库、不进发布包。
