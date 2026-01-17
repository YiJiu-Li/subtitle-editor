const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// ========================================
// 转写队列管理（同时只允许一个任务运行）
// ========================================
const transcribeQueue = {
    isRunning: false,      // 是否有任务正在运行
    currentTask: null,     // 当前任务信息
    waitingCount: 0,       // 等待中的请求数
    queue: [],             // 等待队列

    // 获取状态
    getStatus() {
        return {
            isRunning: this.isRunning,
            currentTask: this.currentTask,
            waitingCount: this.queue.length
        };
    },

    // 添加任务到队列
    enqueue(task) {
        return new Promise((resolve, reject) => {
            const queueItem = { task, resolve, reject };

            if (!this.isRunning) {
                // 没有任务在运行，直接执行
                this.runTask(queueItem);
            } else {
                // 有任务在运行，加入队列
                this.queue.push(queueItem);
                console.log(`[Queue] 任务已加入队列，当前排队: ${this.queue.length}`);
            }
        });
    },

    // 执行任务
    async runTask(queueItem) {
        this.isRunning = true;
        this.currentTask = {
            startTime: Date.now(),
            filename: queueItem.task.filename
        };

        try {
            const result = await queueItem.task.execute();
            queueItem.resolve(result);
        } catch (error) {
            queueItem.reject(error);
        } finally {
            this.isRunning = false;
            this.currentTask = null;
            this.processNext();
        }
    },

    // 处理下一个任务
    processNext() {
        if (this.queue.length > 0) {
            const nextItem = this.queue.shift();
            console.log(`[Queue] 处理下一个任务，剩余排队: ${this.queue.length}`);
            this.runTask(nextItem);
        }
    }
};

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 确保上传目录存在
const uploadsDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// 配置文件上传
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB限制
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /audio|video/;
        const mimetype = allowedTypes.test(file.mimetype);
        if (mimetype) {
            return cb(null, true);
        }
        cb(new Error('只允许上传音频或视频文件'));
    }
});

// Whisper 配置
const WHISPER_CONFIG = {
    model: process.env.WHISPER_MODEL || 'base',  // tiny, base, small, medium, large
    language: process.env.WHISPER_LANG || 'zh',  // 中文
    device: 'cpu',  // 只使用CPU
    threads: process.env.WHISPER_THREADS || 4    // CPU线程数
};

/**
 * 使用Python Whisper进行音频转写
 * @param {string} audioPath - 音频文件路径
 * @param {string} outputPath - 输出文件路径
 * @param {object} options - 转写选项
 */
function transcribeWithWhisper(audioPath, outputPath, options = {}) {
    return new Promise((resolve, reject) => {
        const {
            model = WHISPER_CONFIG.model,
            language = WHISPER_CONFIG.language,
            task = 'transcribe'  // transcribe 或 translate
        } = options;

        // 构建Python脚本参数
        const pythonScript = path.join(__dirname, 'scripts', 'whisper_transcribe.py');

        const args = [
            pythonScript,
            '--audio', audioPath,
            '--output', outputPath,
            '--model', model,
            '--language', language,
            '--task', task,
            '--device', 'cpu',
            '--threads', String(WHISPER_CONFIG.threads)
        ];

        console.log(`[Whisper] 开始转写: ${path.basename(audioPath)}`);
        console.log(`[Whisper] 模型: ${model}, 语言: ${language}, 任务: ${task}`);

        // Windows上使用 py，其他系统使用 python
        const pythonCmd = process.platform === 'win32' ? 'py' : 'python';
        const python = spawn(pythonCmd, args);

        let stdout = '';
        let stderr = '';
        let progress = 0;

        python.stdout.on('data', (data) => {
            const output = data.toString();
            stdout += output;

            // 解析进度信息
            const progressMatch = output.match(/\[PROGRESS\]\s*(\d+)/);
            if (progressMatch) {
                progress = parseInt(progressMatch[1]);
                console.log(`[Whisper] 进度: ${progress}%`);
            }
        });

        python.stderr.on('data', (data) => {
            stderr += data.toString();
            console.error(`[Whisper] ${data}`);
        });

        python.on('close', (code) => {
            if (code === 0) {
                console.log(`[Whisper] 转写完成`);
                resolve({
                    success: true,
                    outputPath: outputPath,
                    message: '转写完成'
                });
            } else {
                console.error(`[Whisper] 转写失败，退出码: ${code}`);
                reject(new Error(`Whisper转写失败: ${stderr || '未知错误'}`));
            }
        });

        python.on('error', (err) => {
            console.error(`[Whisper] 进程错误:`, err);
            reject(new Error(`无法启动Whisper: ${err.message}`));
        });
    });
}

// API路由

// 获取转写队列状态
app.get('/api/transcribe/status', (req, res) => {
    res.json(transcribeQueue.getStatus());
});

// 上传音频并转写（使用队列）
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请上传音频文件' });
        }

        const audioPath = req.file.path;
        const baseName = path.basename(req.file.originalname, path.extname(req.file.originalname));
        const outputPath = path.join(outputDir, `subtitle-${baseName}.json`);

        const options = {
            model: req.body.model || WHISPER_CONFIG.model,
            language: req.body.language || WHISPER_CONFIG.language,
            task: req.body.task || 'transcribe'
        };

        // 使用队列执行转写任务
        const task = {
            filename: req.file.originalname,
            execute: () => transcribeWithWhisper(audioPath, outputPath, options)
        };

        // 如果已有任务在运行，返回排队信息
        if (transcribeQueue.isRunning) {
            console.log(`[Queue] 新任务排队中: ${req.file.originalname}`);
        }

        const result = await transcribeQueue.enqueue(task);

        // 读取生成的字幕文件
        const subtitleData = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));

        res.json({
            success: true,
            message: '转写完成',
            filename: path.basename(outputPath),
            subtitles: subtitleData,
            audioFile: req.file.filename
        });

    } catch (error) {
        console.error('转写错误:', error);
        res.status(500).json({ error: error.message });
    }
});

// 保存字幕文件
app.post('/api/save-subtitle', (req, res) => {
    try {
        const { filename, data } = req.body;

        if (!filename || !data) {
            return res.status(400).json({ error: '缺少文件名或数据' });
        }

        const savePath = path.join(outputDir, filename);
        fs.writeFileSync(savePath, JSON.stringify(data, null, 4), 'utf-8');

        res.json({
            success: true,
            message: '保存成功',
            path: savePath
        });

    } catch (error) {
        console.error('保存错误:', error);
        res.status(500).json({ error: error.message });
    }
});

// 获取字幕文件
app.get('/api/subtitle/:filename', (req, res) => {
    try {
        const filePath = path.join(outputDir, req.params.filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: '文件不存在' });
        }

        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        res.json(data);

    } catch (error) {
        console.error('读取错误:', error);
        res.status(500).json({ error: error.message });
    }
});

// 获取上传的音频文件
app.get('/api/audio/:filename', (req, res) => {
    const filePath = path.join(uploadsDir, req.params.filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '文件不存在' });
    }

    res.sendFile(filePath);
});

// 列出所有字幕文件
app.get('/api/subtitles', (req, res) => {
    try {
        const files = fs.readdirSync(outputDir)
            .filter(f => f.endsWith('.json'))
            .map(f => ({
                name: f,
                path: `/api/subtitle/${f}`,
                created: fs.statSync(path.join(outputDir, f)).birthtime
            }));

        res.json(files);

    } catch (error) {
        console.error('列表错误:', error);
        res.status(500).json({ error: error.message });
    }
});

// 获取Whisper状态
app.get('/api/whisper/status', async (req, res) => {
    try {
        // 检查Python和Whisper是否可用
        // Windows上可能是 py 或 python
        const pythonCmd = process.platform === 'win32' ? 'py' : 'python';
        const python = spawn(pythonCmd, ['--version']);

        let responded = false;

        python.on('close', (code) => {
            if (responded) return;
            responded = true;
            if (code === 0) {
                res.json({
                    available: true,
                    config: WHISPER_CONFIG,
                    message: 'Whisper就绪'
                });
            } else {
                res.json({
                    available: false,
                    message: 'Python未安装或不可用'
                });
            }
        });

        python.on('error', () => {
            if (responded) return;
            responded = true;
            res.json({
                available: false,
                message: 'Python未安装或不可用'
            });
        });

    } catch (error) {
        res.json({
            available: false,
            message: error.message
        });
    }
});

// 删除文件
app.delete('/api/file/:type/:filename', (req, res) => {
    try {
        const { type, filename } = req.params;
        const dir = type === 'audio' ? uploadsDir : outputDir;
        const filePath = path.join(dir, filename);

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ success: true, message: '删除成功' });
        } else {
            res.status(404).json({ error: '文件不存在' });
        }

    } catch (error) {
        console.error('删除错误:', error);
        res.status(500).json({ error: error.message });
    }
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║     🎬 简易字幕编辑器 - Whisper AI 版                      ║
║                                                            ║
║     服务器运行在: http://localhost:${PORT}                   ║
║                                                            ║
║     Whisper配置:                                           ║
║       - 模型: ${WHISPER_CONFIG.model.padEnd(10)}                              ║
║       - 语言: ${WHISPER_CONFIG.language.padEnd(10)}                              ║
║       - 设备: ${WHISPER_CONFIG.device.padEnd(10)} (仅CPU)                     ║
║       - 线程: ${String(WHISPER_CONFIG.threads).padEnd(10)}                              ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
    `);
});

module.exports = app;
