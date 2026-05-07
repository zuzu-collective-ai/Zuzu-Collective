window.zzCloudinary = {
  cloud: 'dttdndgpr',
  preset: 'zuzu-portal',
  async upload(file, urlInput, statusEl) {
    if (statusEl) statusEl.textContent = 'Uploading…';
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', this.preset);
    const r = await fetch(
      `https://api.cloudinary.com/v1_1/${this.cloud}/image/upload`,
      { method: 'POST', body: fd }
    );
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'Upload failed');
    if (urlInput) {
      urlInput.value = data.secure_url;
      urlInput.dispatchEvent(new Event('input'));
    }
    if (statusEl) {
      statusEl.textContent = '✓';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    }
    return data.secure_url;
  },
};
