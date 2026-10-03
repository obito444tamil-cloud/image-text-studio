'use strict';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const modeButtons = [...document.querySelectorAll('.mode-button')];
const generatePanel = document.querySelector('#generate-panel');
const recognizePanel = document.querySelector('#recognize-panel');
const assistantPanel = document.querySelector('#assistant-panel');
const promptInput = document.querySelector('#prompt');
const promptCount = document.querySelector('#prompt-count');
const generateButton = document.querySelector('#generate-button');
const generationResult = document.querySelector('#generation-result');
const imageFileInput = document.querySelector('#image-file');
const uploadBox = document.querySelector('#upload-box');
const uploadTitle = document.querySelector('#upload-title');
const previewWrap = document.querySelector('#preview-wrap');
const imagePreview = document.querySelector('#image-preview');
const recognizeButton = document.querySelector('#recognize-button');
const textOutput = document.querySelector('#text-output');
const copyButton = document.querySelector('#copy-text');
const downloadButton = document.querySelector('#download-text');
const statusMessage = document.querySelector('#status-message');
const chatForm = document.querySelector('#chat-form');
const chatInput = document.querySelector('#chat-input');
const chatMessages = document.querySelector('#chat-messages');
const chatSendButton = document.querySelector('#chat-send');

let selectedFile = null;
let previewUrl = null;
let recognizedText = '';
const conversation = [];

function showStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle('is-error', isError);
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.dataset.originalLabel ||= button.querySelector('span').textContent;
  button.querySelector('span').textContent = busy ? label : button.dataset.originalLabel;
}

function setMode(mode) {
  modeButtons.forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  generatePanel.hidden = mode !== 'generate';
  recognizePanel.hidden = mode !== 'recognize';
  assistantPanel.hidden = mode !== 'assistant';
  showStatus('');
}

modeButtons.forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));

document.querySelector('.mode-switch').addEventListener('keydown', (event) => {
  const currentIndex = modeButtons.indexOf(document.activeElement);
  if (currentIndex < 0) return;

  let nextIndex;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    nextIndex = (currentIndex + 1) % modeButtons.length;
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextIndex = (currentIndex - 1 + modeButtons.length) % modeButtons.length;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = modeButtons.length - 1;
  } else {
    return;
  }

  event.preventDefault();
  modeButtons[nextIndex].focus();
  setMode(modeButtons[nextIndex].dataset.mode);
});

promptInput.addEventListener('input', () => {
  promptCount.textContent = `${promptInput.value.length} / 1000`;
});

document.querySelectorAll('.idea-chip').forEach((button) => {
  button.addEventListener('click', () => {
    promptInput.value = button.dataset.prompt;
    promptInput.dispatchEvent(new Event('input', { bubbles: true }));
    promptInput.focus();
    showStatus('Example added. Make it your own or create an image.');
  });
});

async function postJson(path, data) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The server returned an unreadable response. Please try again.');
  }
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}

generateButton.addEventListener('click', async () => {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    showStatus('Write a description for your image first.', true);
    promptInput.focus();
    return;
  }

  setBusy(generateButton, true, 'Creating your image...');
  const startedAt = Date.now();
  const progress = document.createElement('div');
  progress.className = 'generation-progress';
  progress.setAttribute('role', 'status');
  const spinner = document.createElement('span');
  spinner.className = 'generation-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const progressCopy = document.createElement('div');
  progressCopy.className = 'generation-progress-copy';
  const progressTitle = document.createElement('h3');
  progressTitle.textContent = 'Creating your image';
  const progressDetail = document.createElement('p');
  progressDetail.textContent = 'Using fast generation. 0 seconds';
  progressCopy.append(progressTitle, progressDetail);
  progress.append(spinner, progressCopy);
  generationResult.replaceChildren(progress);
  const progressTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    progressDetail.textContent = `Using fast generation. ${elapsed} ${elapsed === 1 ? 'second' : 'seconds'}`;
  }, 1000);
  showStatus('Your image is being generated.');
  try {
    const result = await postJson('/api/generate-image', {
      prompt,
      size: document.querySelector('#image-size').value
    });
    const wrapper = document.createElement('div');
    wrapper.className = 'generated-wrap';
    const image = document.createElement('img');
    image.className = 'generated-image';
    image.src = result.image;
    image.alt = `Generated image: ${prompt}`;
    const download = document.createElement('a');
    download.className = 'download-link';
    download.href = result.image;
    download.download = 'canvas-generated-image.png';
    download.textContent = '↓  Download image';
    wrapper.append(image, download);
    generationResult.replaceChildren(wrapper);
    showStatus('Your image is ready.');
  } catch (error) {
    spinner.remove();
    progressTitle.textContent = 'Image could not be created';
    progressDetail.textContent = error.message;
    progress.classList.add('has-error');
    showStatus(error.message, true);
  } finally {
    clearInterval(progressTimer);
    setBusy(generateButton, false);
  }
});

function clearSelectedImage() {
  selectedFile = null;
  imageFileInput.value = '';
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  imagePreview.removeAttribute('src');
  previewWrap.classList.add('is-hidden');
  uploadBox.classList.remove('is-hidden');
  uploadTitle.innerHTML = 'Drop an image here or <span>browse files</span>';
  recognizeButton.disabled = true;
}

function selectImage(file) {
  if (!file) return;
  if (!ALLOWED_TYPES.has(file.type)) {
    showStatus('Choose a PNG, JPG, or WebP image.', true);
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    showStatus('This image is larger than 5 MB. Choose a smaller image.', true);
    return;
  }
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  selectedFile = file;
  previewUrl = URL.createObjectURL(file);
  imagePreview.src = previewUrl;
  uploadBox.classList.add('is-hidden');
  previewWrap.classList.remove('is-hidden');
  recognizeButton.disabled = false;
  showStatus('');
}

imageFileInput.addEventListener('change', () => selectImage(imageFileInput.files[0]));
document.querySelector('#remove-image').addEventListener('click', clearSelectedImage);

for (const eventName of ['dragenter', 'dragover']) {
  uploadBox.addEventListener(eventName, (event) => {
    event.preventDefault();
    uploadBox.classList.add('is-dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  uploadBox.addEventListener(eventName, (event) => {
    event.preventDefault();
    uploadBox.classList.remove('is-dragging');
  });
}
uploadBox.addEventListener('drop', (event) => selectImage(event.dataTransfer.files[0]));

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(new Error('Could not read this image. Try another file.')));
    reader.readAsDataURL(file);
  });
}

function updateRecognizedText(text) {
  recognizedText = text;
  textOutput.textContent = text || 'No text was recognized.';
  textOutput.classList.toggle('has-text', Boolean(text));
  copyButton.disabled = !text;
  downloadButton.disabled = !text;
}

function appendChatMessage(role, text, isError = false) {
  const message = document.createElement('p');
  message.className = `chat-message chat-message-${role}${isError ? ' chat-message-error' : ''}`;
  message.textContent = text;
  chatMessages.append(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return message;
}

document.querySelectorAll('.assistant-suggestion').forEach((button) => {
  button.addEventListener('click', () => {
    chatInput.value = button.dataset.question;
    chatInput.focus();
  });
});

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = chatInput.value.trim();
  if (!content) {
    chatInput.focus();
    return;
  }

  const userMessage = { role: 'user', content };
  conversation.push(userMessage);
  while (conversation.length > 12) conversation.shift();
  appendChatMessage('user', content);
  chatInput.value = '';
  setBusy(chatSendButton, true, 'Thinking...');
  const pendingMessage = appendChatMessage('assistant', 'Thinking…');

  try {
    const result = await postJson('/api/assistant', { messages: conversation });
    pendingMessage.remove();
    conversation.push({ role: 'assistant', content: result.reply });
    while (conversation.length > 12) conversation.shift();
    appendChatMessage('assistant', result.reply);
  } catch (error) {
    pendingMessage.remove();
    appendChatMessage('assistant', error.message, true);
  } finally {
    setBusy(chatSendButton, false);
    chatInput.focus();
  }
});

recognizeButton.addEventListener('click', async () => {
  if (!selectedFile) return;
  setBusy(recognizeButton, true, 'Reading image...');
  showStatus('Reading the text in your image...');
  try {
    const image = await readFileAsDataUrl(selectedFile);
    const result = await postJson('/api/extract-text', { image });
    updateRecognizedText(result.text);
    showStatus('Text recognition is complete.');
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    setBusy(recognizeButton, false);
    recognizeButton.disabled = !selectedFile;
  }
});

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(recognizedText);
    showStatus('Recognized text copied to clipboard.');
  } catch {
    showStatus('Could not access the clipboard. Select the text and copy it manually.', true);
  }
});

downloadButton.addEventListener('click', () => {
  const blobUrl = URL.createObjectURL(new Blob([recognizedText], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = 'recognized-text.txt';
  link.click();
  URL.revokeObjectURL(blobUrl);
  showStatus('Text file downloaded.');
});
