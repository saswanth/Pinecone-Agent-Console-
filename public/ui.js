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
const analyticsFilesBody = document.getElementById('analyticsFilesBody');
const fileChunkBars = document.getElementById('fileChunkBars');
const fileWordBars = document.getElementById('fileWordBars');

const docSourceInput = document.getElementById('docSource');
const updateFileInput = document.getElementById('updateFile');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function print(data) {
  output.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function updateAnalytics(analytics) {
  const totals = analytics?.totals || {};
  const files = analytics?.files || [];
  statFiles.textContent = formatNumber(totals.files);
  statBytes.textContent = formatNumber(totals.bytes);
  statWords.textContent = formatNumber(totals.words);
  statChunks.textContent = formatNumber(totals.estimatedChunks);
  renderAnalyticsTable(files);
  renderBars(fileChunkBars, files, 'estimatedChunks');
  renderBars(fileWordBars, files, 'words');
}

function renderAnalyticsTable(files = []) {
  if (!files.length) {
    analyticsFilesBody.innerHTML = '<tr><td colspan="5" class="muted">No analytics data yet.</td></tr>';
    return;
  }

  analyticsFilesBody.innerHTML = files
    .map((file) => {
      return `
        <tr>
          <td class="mono">${escapeHtml(file.source || 'unknown')}</td>
          <td class="mono">${escapeHtml(file.extension || 'n/a')}</td>
          <td class="mono">${formatNumber(file.bytes)}</td>
          <td class="mono">${formatNumber(file.words)}</td>
          <td class="mono">${formatNumber(file.estimatedChunks)}</td>
        </tr>
      `;
    })
    .join('');
}

function renderBars(container, files = [], metricKey) {
  const topFiles = [...files]
    .sort((a, b) => Number(b?.[metricKey] || 0) - Number(a?.[metricKey] || 0))
    .slice(0, 8);

  if (!topFiles.length) {
    container.innerHTML = '<div class="muted">No data.</div>';
    return;
  }

  const maxValue = Math.max(...topFiles.map((item) => Number(item?.[metricKey] || 0)), 1);
  container.innerHTML = topFiles
    .map((item) => {
      const source = item?.relativeToDocs || item?.source || 'unknown';
      const value = Number(item?.[metricKey] || 0);
      const width = Math.max(2, Math.round((value / maxValue) * 100));
      return `
        <div class="bar-row">
          <div class="bar-label" title="${escapeHtml(source)}">${escapeHtml(source)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
          <div class="bar-value mono">${formatNumber(value)}</div>
        </div>
      `;
    })
    .join('');
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

document.getElementById('deleteDocBtn').addEventListener('click', async () => {
  try {
    const source = docSourceInput.value.trim();
    if (!source) {
      throw new Error('Please enter a document source to delete.');
    }

    print(`Deleting ${source} ...`);
    const data = await fetch('/document', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    }).then(async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Delete failed');
      return body;
    });

    await refreshAnalytics();
    print(data);
  } catch (error) {
    print({ ok: false, error: error.message });
  }
});

document.getElementById('updateDocBtn').addEventListener('click', async () => {
  try {
    const source = docSourceInput.value.trim();
    const file = updateFileInput.files?.[0];
    if (!file) {
      throw new Error('Please choose a replacement file for update.');
    }

    print('Updating document...');
    const form = new FormData();
    form.append('file', file);
    if (source) {
      form.append('source', source);
    }

    const data = await fetch('/document', {
      method: 'PUT',
      body: form,
    }).then(async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Update failed');
      return body;
    });

    await refreshAnalytics();
    print(data);
  } catch (error) {
    print({ ok: false, error: error.message });
  }
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
