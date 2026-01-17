#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Whisper 音频转写脚本
使用 faster-whisper 进行语音识别（CPU优化版本）
比原版 Whisper 快 4 倍，内存占用更少
"""

import argparse
import json
import sys
import os
import glob


def resolve_model_path(model_name):
    """
    解析模型路径
    支持:
    1. 完整路径 (如 /root/.cache/huggingface/models--Systran--faster-whisper-base/snapshots/xxx)
    2. 模型名称 (如 base, small, medium) - 自动从 WHISPER_MODELS_DIR 查找
    3. HuggingFace 模型 ID (如 Systran/faster-whisper-base) - 需要网络下载
    """
    # 如果是完整路径且存在，直接使用
    if os.path.isdir(model_name):
        model_bin = os.path.join(model_name, 'model.bin')
        if os.path.exists(model_bin):
            return model_name
    
    # 从环境变量获取模型目录
    models_dir = os.environ.get('WHISPER_MODELS_DIR', '/root/.cache/huggingface')
    
    # 模型名称映射
    model_map = {
        'tiny': 'models--Systran--faster-whisper-tiny',
        'base': 'models--Systran--faster-whisper-base',
        'small': 'models--Systran--faster-whisper-small',
        'medium': 'models--Systran--faster-whisper-medium',
        'large': 'models--Systran--faster-whisper-large-v3',
        'large-v3': 'models--Systran--faster-whisper-large-v3',
    }
    
    # 如果是简短名称，查找对应目录
    if model_name in model_map:
        model_folder = model_map[model_name]
        snapshots_dir = os.path.join(models_dir, model_folder, 'snapshots')
        
        if os.path.isdir(snapshots_dir):
            # 查找第一个包含 model.bin 的 snapshot
            for snapshot in os.listdir(snapshots_dir):
                snapshot_path = os.path.join(snapshots_dir, snapshot)
                if os.path.isdir(snapshot_path):
                    model_bin = os.path.join(snapshot_path, 'model.bin')
                    if os.path.exists(model_bin):
                        print(f"[INFO] 找到本地模型: {snapshot_path}", file=sys.stderr)
                        return snapshot_path
        
        print(f"[WARN] 本地未找到模型 {model_name}，将尝试在线下载", file=sys.stderr)
    
    # 返回原始名称，让 faster-whisper 自己处理（可能触发下载）
    return model_name


def main():
    parser = argparse.ArgumentParser(
        description="Whisper 音频转写工具 (faster-whisper)"
    )
    parser.add_argument("--audio", required=True, help="音频文件路径")
    parser.add_argument("--output", required=True, help="输出JSON文件路径")
    parser.add_argument(
        "--model",
        default="base",
        help="Whisper模型大小 (tiny, base, small, medium, large-v3)",
    )
    parser.add_argument(
        "--language", default="zh", help="语言代码 (zh, en, ja, ko, auto)"
    )
    parser.add_argument(
        "--task", default="transcribe", help="任务类型 (transcribe, translate)"
    )
    parser.add_argument("--device", default="cpu", help="运行设备 (cpu)")
    parser.add_argument("--threads", type=int, default=8, help="CPU线程数")

    args = parser.parse_args()

    # 设置CPU线程数
    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    os.environ["MKL_NUM_THREADS"] = str(args.threads)

    # 解析模型路径
    model_path = resolve_model_path(args.model)
    print(f"[INFO] 加载 faster-whisper 模型: {model_path}", file=sys.stderr)
    print("[PROGRESS] 10", flush=True)

    try:
        from faster_whisper import WhisperModel

        # 加载模型 - 使用CPU和int8量化以减少内存占用
        model = WhisperModel(
            model_path,
            device="cpu",
            compute_type="int8",  # CPU上使用int8量化，更快更省内存
            cpu_threads=args.threads,
            num_workers=1,
        )

        print("[INFO] 模型加载完成", file=sys.stderr)
        print("[PROGRESS] 20", flush=True)

        # 设置语言
        language = None if args.language == "auto" else args.language

        # 转写音频
        print(f"[INFO] 开始转写: {args.audio}", file=sys.stderr)
        print("[PROGRESS] 30", flush=True)

        # 执行转写
        segments, info = model.transcribe(
            args.audio,
            language=language,
            task=args.task,
            beam_size=5,
            vad_filter=True,  # 启用语音活动检测，更准确
            vad_parameters=dict(
                min_silence_duration_ms=500,  # 最小静音时长
            ),
        )

        print(
            f"[INFO] 检测到语言: {info.language} (概率: {info.language_probability:.2f})",
            file=sys.stderr,
        )
        print("[PROGRESS] 50", flush=True)

        # 字数限制
        MAX_TEXT_LENGTH = 25

        def split_text(text, max_len):
            """将超长文本分割成多段"""
            if len(text) <= max_len:
                return [text]

            result = []
            # 优先按标点分割
            punctuations = [
                "。",
                "！",
                "？",
                "，",
                "、",
                "；",
                ".",
                "!",
                "?",
                ",",
                ";",
                " ",
            ]

            while len(text) > max_len:
                # 在max_len范围内找最后一个标点
                split_pos = -1
                for p in punctuations:
                    pos = text[:max_len].rfind(p)
                    if pos > split_pos:
                        split_pos = pos

                if split_pos <= 0:
                    # 没找到标点，强制在max_len处分割
                    split_pos = max_len - 1

                result.append(text[: split_pos + 1].strip())
                text = text[split_pos + 1 :].strip()

            if text:
                result.append(text)

            return result

        # 转换为目标格式
        subtitles = {"data": []}

        segment_list = list(segments)  # 将生成器转为列表
        total_segments = len(segment_list)

        for i, segment in enumerate(segment_list):
            text = segment.text.strip()
            start_time = round(segment.start, 2)
            end_time = round(segment.end, 2)

            # 如果文本超过25字，进行分割
            if len(text) > MAX_TEXT_LENGTH:
                parts = split_text(text, MAX_TEXT_LENGTH)
                duration = end_time - start_time
                time_per_part = duration / len(parts) if len(parts) > 0 else 0

                for j, part in enumerate(parts):
                    part_time = round(start_time + j * time_per_part, 2)
                    subtitles["data"].append({"time": part_time, "text": part})
            else:
                subtitles["data"].append({"time": start_time, "text": text})

            # 更新进度
            progress = 50 + int((i + 1) / max(total_segments, 1) * 40)
            print(f"[PROGRESS] {progress}", flush=True)

        print("[PROGRESS] 90", flush=True)

        # 保存结果
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(subtitles, f, ensure_ascii=False, indent=4)

        print(f"[INFO] 转写完成，共 {len(subtitles['data'])} 条字幕", file=sys.stderr)
        print("[PROGRESS] 100", flush=True)

        # 输出结果信息
        print(
            json.dumps(
                {
                    "success": True,
                    "segments": len(subtitles["data"]),
                    "language": info.language,
                    "output": args.output,
                }
            )
        )

    except ImportError as e:
        print(f"[ERROR] 缺少依赖: {e}", file=sys.stderr)
        print("[ERROR] 请运行: pip install faster-whisper", file=sys.stderr)
        sys.exit(1)

    except Exception as e:
        print(f"[ERROR] 转写失败: {e}", file=sys.stderr)
        import traceback

        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
