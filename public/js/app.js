/**
 * 简易字幕编辑器 - 前端逻辑
 * 支持Whisper AI音频转写
 */

// ========================================
// 全局变量
// ========================================
const MAX_TEXT_LENGTH = 25;
let subtitles = { data: [] };
let filename = 'subtitle.json';
let wavesurfer;
let currentSubtitleIndex = -1;
let selectedSubtitleIndex = -1;
let currentAudioFile = null;

// ========================================
// DOM元素
// ========================================
const subtitleListEl = document.getElementById('subtitleList');
const filenameEl = document.getElementById('filename');
const jsonFileEl = document.getElementById('jsonFile');
const audioFileEl = document.getElementById('audioFile');
const saveBtn = document.getElementById('saveBtn');
const playBtn = document.getElementById('playBtn');
const stopBtn = document.getElementById('stopBtn');
const addSubtitleBtn = document.getElementById('addSubtitleBtn');
const syncTimeBtn = document.getElementById('syncTimeBtn');
const currentTimeEl = document.getElementById('currentTime');
const currentTimeDisplayEl = document.getElementById('currentTimeDisplay');
const timePreviewEl = document.getElementById('timePreview');
const previewLineEl = document.getElementById('previewLine');
const selectionStatusEl = document.getElementById('selectionStatus');
const currentSubtitlePreviewEl = document.getElementById('currentSubtitlePreview');
const jsonFileNameEl = document.getElementById('jsonFileName');
const audioFileNameEl = document.getElementById('audioFileName');

// AI转写相关元素
const transcribeBtn = document.getElementById('transcribeBtn');
const transcribePanel = document.getElementById('transcribePanel');
const startTranscribeBtn = document.getElementById('startTranscribeBtn');
const cancelTranscribeBtn = document.getElementById('cancelTranscribeBtn');
const modelSelect = document.getElementById('modelSelect');
const languageSelect = document.getElementById('languageSelect');
const taskSelect = document.getElementById('taskSelect');
const transcribeProgress = document.getElementById('transcribeProgress');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');

// ========================================
// 工具函数
// ========================================

/**
 * 获取字数计数器样式类
 */
function getCharCounterClass(length) {
    if (length > MAX_TEXT_LENGTH) return 'char-counter error';
    if (length >= MAX_TEXT_LENGTH * 0.8) return 'char-counter warning';
    return 'char-counter ok';
}

/**
 * 根据音频文件名生成字幕文件名
 */
function generateSubtitleFilename(audioFilename) {
    const nameWithoutExt = audioFilename.replace(/\.[^/.]+$/, '');
    if (nameWithoutExt.startsWith('sound-')) {
        return nameWithoutExt.replace(/^sound-/, 'subtitle-') + '.json';
    }
    return 'subtitle-' + nameWithoutExt + '.json';
}

/**
 * 格式化时间显示
 */
function formatTime(time) {
    if (isNaN(time) || time === undefined) return '00:00.00';
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    const milliseconds = Math.floor((time % 1) * 100);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(2, '0')}`;
}

/**
 * 格式化时间线时间
 */
function formatTimelineTime(time) {
    if (isNaN(time) || time === undefined) return '0秒';
    return time === 0 ? '0' : `${Math.floor(time)}秒`;
}

/**
 * 防抖函数
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// ========================================
// WaveSurfer 初始化
// ========================================

document.addEventListener('DOMContentLoaded', function() {
    filenameEl.value = filename;
    currentSubtitlePreviewEl.textContent = '请加载音频和字幕文件后开始播放';

    // 初始化WaveSurfer
    wavesurfer = WaveSurfer.create({
        container: '#waveform',
        waveColor: '#cbd5e1',
        progressColor: '#6366f1',
        height: 80,
        barWidth: 2,
        barGap: 1,
        responsive: true,
        interact: true,
        plugins: [
            WaveSurfer.timeline.create({
                container: '#timeline',
                primaryColor: '#4a6cf7',
                secondaryColor: '#3a5ce5',
                primaryFontColor: '#333',
                secondaryFontColor: '#777',
                fontSize: 12,
                timeInterval: 1,
                primaryLabelInterval: 5,
                formatTimeCallback: formatTimelineTime
            })
        ]
    });

    // 波形点击事件
    wavesurfer.on('click', function(e) {
        if (wavesurfer.isPlaying()) {
            wavesurfer.pause();
            updatePlayButton(false);
        }
    });

    // 波形容器事件
    const waveformContainer = document.querySelector('.waveform-container');
    
    waveformContainer.addEventListener('click', function(e) {
        if (!wavesurfer.isReady) return;
        const rect = waveformContainer.getBoundingClientRect();
        const relX = e.clientX - rect.left;
        const percent = relX / rect.width;
        const duration = wavesurfer.getDuration();
        const time = percent * duration;
        
        currentTimeEl.style.left = `${percent * 100}%`;
        updateCurrentTimeDisplay(time);
        highlightCurrentSubtitle(time);
        
        if (wavesurfer.isPlaying()) {
            wavesurfer.pause();
            updatePlayButton(false);
        }
        
        setTimeout(() => {
            wavesurfer.setCurrentTime(time);
        }, 10);
        
        e.stopPropagation();
    });

    waveformContainer.addEventListener('mousemove', function(e) {
        if (!wavesurfer.isReady) return;
        const rect = waveformContainer.getBoundingClientRect();
        const relX = e.clientX - rect.left;
        const percent = relX / rect.width;
        const duration = wavesurfer.getDuration();
        const previewTime = percent * duration;
        
        previewLineEl.style.left = `${percent * 100}%`;
        previewLineEl.style.display = 'block';
        timePreviewEl.textContent = formatTime(previewTime);
        timePreviewEl.style.left = `${relX}px`;
        timePreviewEl.style.top = `${e.clientY - rect.top - 30}px`;
        timePreviewEl.style.display = 'block';
    });

    waveformContainer.addEventListener('mouseleave', function() {
        previewLineEl.style.display = 'none';
        timePreviewEl.style.display = 'none';
    });

    // 音频播放进度更新
    wavesurfer.on('audioprocess', function() {
        const time = wavesurfer.getCurrentTime();
        updateCurrentTimeDisplay(time);
        updateCurrentTimeMarker();
        highlightCurrentSubtitle(time);
        const idx = findSubtitleByTime(time);
        updateSubtitlePreview(idx);
    });

    wavesurfer.on('seek', function(position) {
        const time = position * wavesurfer.getDuration();
        updateCurrentTimeDisplay(time);
        updateCurrentTimeMarker();
        highlightCurrentSubtitle(time);
    });

    wavesurfer.on('ready', function() {
        updateCurrentTimeMarker();
        updateCurrentTimeDisplay(0);
        playBtn.disabled = false;
        updatePlayButton(false);
        
        if (subtitles.data.length > 0) {
            currentSubtitlePreviewEl.textContent = '准备就绪，点击播放查看字幕';
        } else {
            currentSubtitlePreviewEl.textContent = '已加载音频，请添加或加载字幕';
        }
    });

    // 初始化字幕数据
    subtitles = { data: [] };
    renderSubtitles();
    
    // 检查Whisper状态
    checkWhisperStatus();
});

// ========================================
// 播放控制
// ========================================

function updatePlayButton(isPlaying) {
    if (isPlaying) {
        playBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" class="icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            暂停
        `;
    } else {
        playBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" class="icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            播放
        `;
    }
}

function updateCurrentTimeDisplay(time) {
    currentTimeDisplayEl.textContent = formatTime(time);
}

function updateCurrentTimeMarker() {
    if (wavesurfer && wavesurfer.isReady) {
        const currentTime = wavesurfer.getCurrentTime();
        const duration = wavesurfer.getDuration();
        if (duration > 0) {
            const percent = currentTime / duration;
            const position = Math.max(0, Math.min(100, percent * 100));
            currentTimeEl.style.left = `${position}%`;
        }
    }
}

// ========================================
// 字幕管理
// ========================================

function renderSubtitles() {
    subtitleListEl.innerHTML = '';

    subtitles.data.forEach((subtitle, index) => {
        const subtitleItem = document.createElement('div');
        subtitleItem.className = 'subtitle-item';
        subtitleItem.dataset.index = index;
        
        if (index === currentSubtitleIndex) subtitleItem.classList.add('active');
        if (index === selectedSubtitleIndex) subtitleItem.classList.add('selected');

        const textLength = subtitle.text.length;
        const isOverLimit = textLength > MAX_TEXT_LENGTH;
        const inputErrorClass = isOverLimit ? 'text-input-error' : '';

        subtitleItem.innerHTML = `
            <span class="index">${index + 1}</span>
            <input type="number" class="time-input" value="${subtitle.time}" step="0.01" min="0" data-index="${index}">
            <div class="text-input-wrapper">
                <input type="text" class="text-input ${inputErrorClass}" value="${subtitle.text}" maxlength="30" placeholder="输入字幕内容..." data-index="${index}">
                <span class="${getCharCounterClass(textLength)}" data-counter="${index}">${textLength}/${MAX_TEXT_LENGTH}</span>
            </div>
            <button class="jump-btn" data-time="${subtitle.time}">跳转</button>
            <button class="delete-btn" data-index="${index}">删除</button>
        `;

        subtitleListEl.appendChild(subtitleItem);
    });

    setupEventDelegation();
    updateSelectionStatus();
}

function setupEventDelegation() {
    subtitleListEl.removeEventListener('click', handleListClick);
    subtitleListEl.removeEventListener('input', handleListInput);
    subtitleListEl.removeEventListener('change', handleListChange);

    subtitleListEl.addEventListener('click', handleListClick);
    subtitleListEl.addEventListener('input', handleListInput);
    subtitleListEl.addEventListener('change', handleListChange);
}

function handleListClick(e) {
    const target = e.target;

    if (target.classList.contains('jump-btn')) {
        const time = parseFloat(target.dataset.time);
        jumpToTime(time);
        return;
    }

    if (target.classList.contains('delete-btn')) {
        const index = parseInt(target.dataset.index);
        deleteSubtitle(index);
        return;
    }

    if (!target.matches('input, button')) {
        const subtitleItem = target.closest('.subtitle-item');
        if (subtitleItem) {
            const index = parseInt(subtitleItem.dataset.index);
            selectSubtitle(index);
        }
    }
}

function handleListInput(e) {
    const target = e.target;

    if (target.classList.contains('text-input')) {
        const index = parseInt(target.dataset.index);
        let newText = target.value;

        if (newText.length > MAX_TEXT_LENGTH) {
            newText = newText.substring(0, MAX_TEXT_LENGTH);
            target.value = newText;
        }

        subtitles.data[index].text = newText;

        const counter = document.querySelector(`[data-counter="${index}"]`);
        if (counter) {
            counter.textContent = `${newText.length}/${MAX_TEXT_LENGTH}`;
            counter.className = getCharCounterClass(newText.length);
        }

        if (newText.length > MAX_TEXT_LENGTH) {
            target.classList.add('text-input-error');
        } else {
            target.classList.remove('text-input-error');
        }
    }
}

function handleListChange(e) {
    const target = e.target;

    if (target.classList.contains('time-input')) {
        const index = parseInt(target.dataset.index);
        const newTime = parseFloat(target.value);
        subtitles.data[index].time = newTime;
        sortSubtitles();
        renderSubtitles();
    }
}

function selectSubtitle(index) {
    document.querySelectorAll('.subtitle-item').forEach((item, i) => {
        item.classList.remove('selected');
        if (i === index) {
            item.classList.add('selected');
        }
    });
    selectedSubtitleIndex = index;
    updateSelectionStatus();
}

function updateSelectionStatus() {
    if (selectedSubtitleIndex === -1) {
        selectionStatusEl.textContent = '无';
        selectionStatusEl.className = 'status-badge gray';
    } else {
        selectionStatusEl.textContent = `第 ${selectedSubtitleIndex + 1} 条`;
        selectionStatusEl.className = 'status-badge green';
    }
}

function deleteSubtitle(index) {
    subtitles.data.splice(index, 1);
    if (selectedSubtitleIndex === index) selectedSubtitleIndex = -1;
    else if (selectedSubtitleIndex > index) selectedSubtitleIndex--;
    renderSubtitles();
}

function sortSubtitles() {
    subtitles.data.sort((a, b) => a.time - b.time);
}

function jumpToTime(time) {
    if (wavesurfer.isReady) {
        if (wavesurfer.isPlaying()) {
            wavesurfer.pause();
            updatePlayButton(false);
        }
        const duration = wavesurfer.getDuration();
        const safeTime = Math.max(0, Math.min(time, duration));
        const percent = safeTime / duration;
        
        currentTimeEl.style.left = `${percent * 100}%`;
        updateCurrentTimeDisplay(safeTime);
        highlightCurrentSubtitle(safeTime);
        wavesurfer.seekTo(percent);
        updateCurrentTimeMarker();
    }
}

function findSubtitleByTime(time) {
    let foundIndex = -1;
    for (let i = 0; i < subtitles.data.length - 1; i++) {
        if (time >= subtitles.data[i].time && time < subtitles.data[i + 1].time) {
            if (subtitles.data[i].text.trim() === '' && i < subtitles.data.length - 1) {
                foundIndex = -2;
            } else {
                foundIndex = i;
            }
            break;
        }
    }
    if (foundIndex === -1 && subtitles.data.length > 0 && time >= subtitles.data[subtitles.data.length - 1].time) {
        foundIndex = subtitles.data.length - 1;
    }
    return foundIndex;
}

function highlightCurrentSubtitle(currentTime) {
    const foundIndex = findSubtitleByTime(currentTime);
    updateSubtitlePreviewArea(foundIndex);
    
    if (foundIndex !== currentSubtitleIndex) {
        document.querySelectorAll('.subtitle-item').forEach((item, i) => {
            item.classList.remove('active');
            if (i === foundIndex && foundIndex >= 0) {
                item.classList.add('active');
            }
        });
        currentSubtitleIndex = foundIndex;
    }
}

function updateSubtitlePreviewArea(subtitleIndex) {
    if (subtitleIndex === -2) {
        currentSubtitlePreviewEl.textContent = '';
        currentSubtitlePreviewEl.style.animation = 'none';
        setTimeout(() => {
            currentSubtitlePreviewEl.style.animation = 'subtitleFade 0.5s ease-in-out';
        }, 10);
    } else if (subtitleIndex !== -1 && subtitleIndex < subtitles.data.length) {
        const subtitle = subtitles.data[subtitleIndex];
        currentSubtitlePreviewEl.textContent = subtitle.text.trim() === '' ? '' : subtitle.text;
        currentSubtitlePreviewEl.style.animation = 'none';
        setTimeout(() => {
            currentSubtitlePreviewEl.style.animation = 'subtitleFade 0.5s ease-in-out';
        }, 10);
    } else {
        currentSubtitlePreviewEl.textContent = '';
    }
}

function updateSubtitlePreview(subtitleIndex) {
    updateSubtitlePreviewArea(subtitleIndex);
}

// ========================================
// AI转写功能
// ========================================

async function checkWhisperStatus() {
    try {
        const response = await fetch('/api/whisper/status');
        const data = await response.json();
        
        if (data.available) {
            transcribeBtn.disabled = false;
            transcribeBtn.title = `Whisper就绪 (模型: ${data.config.model})`;
        } else {
            transcribeBtn.disabled = true;
            transcribeBtn.title = `Whisper不可用: ${data.message}`;
        }
    } catch (error) {
        console.warn('无法连接到服务器，AI转写功能不可用');
        transcribeBtn.disabled = true;
        transcribeBtn.title = '服务器未启动，AI转写功能不可用';
    }
}

function showTranscribePanel() {
    transcribePanel.classList.remove('hidden');
}

function hideTranscribePanel() {
    transcribePanel.classList.add('hidden');
    transcribeProgress.classList.add('hidden');
}

async function startTranscribe() {
    if (!currentAudioFile) {
        alert('请先选择音频文件');
        return;
    }

    const model = modelSelect.value;
    const language = languageSelect.value;
    const task = taskSelect.value;

    // 显示进度
    transcribeProgress.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = '正在检查队列状态...';
    startTranscribeBtn.disabled = true;

    try {
        // 先检查队列状态
        const statusResp = await fetch('/api/transcribe/status');
        const status = await statusResp.json();
        
        if (status.isRunning) {
            progressText.textContent = `排队中... 前面还有 ${status.waitingCount + 1} 个任务`;
            progressFill.style.width = '5%';
        } else {
            progressText.textContent = '正在上传音频文件...';
        }

        const formData = new FormData();
        formData.append('audio', currentAudioFile);
        formData.append('model', model);
        formData.append('language', language);
        formData.append('task', task);

        // 开始轮询队列状态
        const pollInterval = setInterval(async () => {
            try {
                const pollResp = await fetch('/api/transcribe/status');
                const pollStatus = await pollResp.json();
                if (pollStatus.isRunning && pollStatus.waitingCount > 0) {
                    progressText.textContent = `排队中... 前面还有 ${pollStatus.waitingCount} 个任务`;
                } else if (pollStatus.isRunning) {
                    progressText.textContent = '正在转写中，请耐心等待...';
                    progressFill.style.width = '30%';
                }
            } catch (e) {
                // 忽略轮询错误
            }
        }, 2000);

        const response = await fetch('/api/transcribe', {
            method: 'POST',
            body: formData
        });

        clearInterval(pollInterval);

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '转写失败');
        }

        progressFill.style.width = '90%';
        progressText.textContent = '正在处理结果...';

        const result = await response.json();

        // 加载转写结果
        subtitles = result.subtitles;
        filename = result.filename;
        filenameEl.value = filename;
        
        renderSubtitles();

        progressFill.style.width = '100%';
        progressText.textContent = '转写完成！';

        setTimeout(() => {
            hideTranscribePanel();
            currentSubtitlePreviewEl.textContent = '转写完成，准备就绪';
        }, 1500);

    } catch (error) {
        console.error('转写错误:', error);
        progressText.textContent = `转写失败: ${error.message}`;
        progressFill.style.width = '0%';
    } finally {
        startTranscribeBtn.disabled = false;
    }
}

// ========================================
// 文件操作
// ========================================

function exportJsonFile() {
    const jsonString = JSON.stringify(subtitles, null, 4);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const saveFilename = filenameEl.value || filename;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = saveFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ========================================
// 事件监听器
// ========================================

// 添加字幕按钮
addSubtitleBtn.addEventListener('click', function() {
    const currentTime = wavesurfer.isReady ? wavesurfer.getCurrentTime() : 0;
    subtitles.data.push({
        time: parseFloat(currentTime.toFixed(2)),
        text: ''
    });
    sortSubtitles();
    renderSubtitles();
    
    setTimeout(() => {
        let newSubtitleIndex = -1;
        for (let i = 0; i < subtitles.data.length; i++) {
            if (Math.abs(subtitles.data[i].time - currentTime) < 0.01) {
                newSubtitleIndex = i;
                break;
            }
        }
        if (newSubtitleIndex !== -1) {
            selectSubtitle(newSubtitleIndex);
            const subtitleItems = document.querySelectorAll('.subtitle-item');
            if (subtitleItems[newSubtitleIndex]) {
                subtitleItems[newSubtitleIndex].scrollIntoView({
                    behavior: 'smooth',
                    block: 'center'
                });
                const textInput = subtitleItems[newSubtitleIndex].querySelector('.text-input');
                if (textInput) {
                    setTimeout(() => textInput.focus(), 100);
                }
            }
        }
    }, 100);
});

// 同步时间按钮
syncTimeBtn.addEventListener('click', function() {
    if (selectedSubtitleIndex !== -1 && wavesurfer.isReady) {
        const currentTime = wavesurfer.getCurrentTime();
        subtitles.data[selectedSubtitleIndex].time = parseFloat(currentTime.toFixed(2));
        sortSubtitles();
        renderSubtitles();
    }
});

// JSON文件选择
jsonFileEl.addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    filename = file.name;
    filenameEl.value = filename;
    jsonFileNameEl.textContent = file.name.length > 15 ? file.name.substring(0, 12) + '...' : file.name;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const loadedData = JSON.parse(e.target.result);
            if (loadedData.data) {
                loadedData.data.forEach(item => {
                    if (item.text && item.text.length > MAX_TEXT_LENGTH) {
                        item.text = item.text.substring(0, MAX_TEXT_LENGTH);
                    }
                });
            }
            subtitles = loadedData;
            renderSubtitles();
            
            if (subtitles.data.length > 0) {
                currentSubtitlePreviewEl.textContent = '已加载字幕，准备就绪';
            } else {
                currentSubtitlePreviewEl.textContent = '字幕文件为空';
            }
        } catch (error) {
            console.error('JSON格式错误:', error);
            alert('JSON文件格式错误，请检查文件内容');
        }
    };
    reader.readAsText(file);
});

// 音频文件选择
audioFileEl.addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;

    currentAudioFile = file;
    audioFileNameEl.textContent = file.name.length > 15 ? file.name.substring(0, 12) + '...' : file.name;

    const generatedFilename = generateSubtitleFilename(file.name);
    filename = generatedFilename;
    filenameEl.value = generatedFilename;

    const audioUrl = URL.createObjectURL(file);
    wavesurfer.load(audioUrl);
    updatePlayButton(false);
    currentSubtitleIndex = -1;
});

// 播放按钮
playBtn.addEventListener('click', function() {
    if (wavesurfer.isReady) {
        wavesurfer.playPause();
        updatePlayButton(wavesurfer.isPlaying());
    }
});

// 停止按钮
stopBtn.addEventListener('click', function() {
    if (wavesurfer.isReady) {
        wavesurfer.stop();
        updatePlayButton(false);
    }
});

// 保存按钮
saveBtn.addEventListener('click', function() {
    exportJsonFile();
});

// AI转写按钮
transcribeBtn.addEventListener('click', function() {
    if (!currentAudioFile) {
        alert('请先选择音频文件');
        return;
    }
    showTranscribePanel();
});

// 开始转写按钮
startTranscribeBtn.addEventListener('click', startTranscribe);

// 取消转写按钮
cancelTranscribeBtn.addEventListener('click', hideTranscribePanel);

// 文件名输入
filenameEl.addEventListener('change', function() {
    filename = filenameEl.value;
});

// 键盘快捷键
document.addEventListener('keydown', function(e) {
    // 空格键播放/暂停
    if (e.code === 'Space' && !e.target.matches('input, textarea')) {
        e.preventDefault();
        playBtn.click();
    }
    
    // 左右方向键跳转
    if (wavesurfer.isReady && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        if (e.target.matches('input, textarea')) return;
        e.preventDefault();
        const skipAmount = e.shiftKey ? 5 : 1;
        const currentTime = wavesurfer.getCurrentTime();
        let newTime = currentTime + (e.code === 'ArrowRight' ? skipAmount : -skipAmount);
        newTime = Math.max(0, Math.min(wavesurfer.getDuration(), newTime));
        wavesurfer.seekTo(newTime / wavesurfer.getDuration());
        updateCurrentTimeDisplay(newTime);
        updateCurrentTimeMarker();
    }
    
    // Ctrl+S 保存
    if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveBtn.click();
    }
});
