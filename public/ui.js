const output = document.getElementById('output');
const healthText = document.getElementById('healthText');
const healthDot = document.getElementById('healthDot');
const filesInput = document.getElementById('files');
const resultsBody = document.getElementById('resultsBody');
const docsDirInput = document.getElementById('docsDir');
const dropzone = document.getElementById('dropzone');

const statFiles = document.getElementById('statFiles');
const statBytes = document.getElementById('statBytes');
const statWords = document.getElementById('statWords');
const statChunks = document.getElementById('statChunks');

function print(data) {
  output.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function updateAnalytics(analytics) {
  const totals = analytics?.totals || {};
  statFiles.textContent = formatNumber(totals.files);
  statBytes.textContent = formatNumber(totals.bytes);
  statWords.textContent = formatNumber(totals.words);
  statChunks.textContent = formatNumber(totals.estimatedChunks);
}

function renderResults(matches = []) {
  if (!matches.length) {
    resultsBody.innerHTML = '<tr><td colspan="3" class="muted">No query results yet.</td></tr>';
    return;
  }

  resultsBody.innerHTML = matches
    .map((match) => {
      const source = match?.metadata?.source || 'unknown';
      const score = typeof match?.score === 'number' ? match.score.toFixed(4) : 'n/a';
      const text = String(match?.metadata?.text || '').slice(0, 240);
      return `
        <tr>
          <td class="mono">${source}</td>
          <td class="mono">${score}</td>
          <td>${text}</td>
        </tr>
      `;
    })
    .join('');
}

async function refreshAnalytics() {
  try {
    const docsDir = docsDirInput.value || './docs';
    const res = await fetch(`/analytics?docsDir=${encodeURIComponent(docsDir)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'Analytics request failed');
    updateAnalytics(data.analytics);
    return data;
  } catch (error) {
    print({ ok: false, error: error.message });
    return null;
  }
}

function setFiles(fileList) {
  const transfer = new DataTransfer();
  for (const file of fileList) {
    transfer.items.add(file);
  }
  filesInput.files = transfer.files;
  print(`${transfer.files.length} file(s) selected.`);
}

async function uploadSelectedFiles() {
  const files = filesInput.files;
  if (!files || files.length === 0) {
    print({ ok: false, error: 'Choose at least one file first.' });
    return;
  }

  try {
    print('Uploading and ingesting...');
    const form = new FormData();
    for (const file of files) {
      form.append('files', file);
    }

    const res = await fetch('/upload-ingest', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'Upload failed');
    updateAnalytics(data.analytics);
    print(data);
  } catch (error) {
    print({ ok: false, error: error.message });
  }
}

async function checkHealth() {
  try {
    const res = await fetch('/health');
    const data = await res.json();

    const ready = Boolean(data?.ok);
    healthDot.classList.toggle('ready', ready);
    healthText.textContent = ready ? 'Ready' : 'Config missing';
    return data;
  } catch (error) {
    healthDot.classList.remove('ready');
    healthText.textContent = 'Offline';
    return { ok: false, error: error.message };
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'Request failed');
  return data;
}

document.getElementById('ingestBtn').addEventListener('click', async () => {
  try {
    print('Running ingest...');
    const docsDir = docsDirInput.value || './docs';
    const data = await postJson('/ingest', { docsDir });
    updateAnalytics(data.analytics);
    print(data);
  } catch (error) {
    print({ ok: false, error: error.message });
  }
});

document.getElementById('uploadBtn').addEventListener('click', uploadSelectedFiles);

document.getElementById('analyticsBtn').addEventListener('click', async () => {
  print('Refreshing analytics...');
  const data = await refreshAnalytics();
  if (data) print(data);
});

filesInput.addEventListener('change', () => {
  const count = filesInput.files?.length || 0;
  if (count > 0) {
    print(`${count} file(s) selected.`);
  }
});

dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragover');
  const droppedFiles = event.dataTransfer?.files;
  if (droppedFiles?.length) {
    setFiles(droppedFiles);
  }
});

document.getElementById('queryBtn').addEventListener('click', async () => {
  try {
    print('Running query...');
    const text = document.getElementById('queryText').value.trim();
    if (!text) {
      throw new Error('Please enter a query.');
    }

    const data = await postJson('/query', { text });
    renderResults(data.matches || []);
    print(data);
  } catch (error) {
    renderResults([]);
    print({ ok: false, error: error.message });
  }
});

checkHealth();
refreshAnalytics();
setInterval(checkHealth, 12000);
