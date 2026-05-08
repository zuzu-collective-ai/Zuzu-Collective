window.zzCloudinary = {
  cloud: 'dttdndgpr',
  preset: 'zuzu-portal',
  async upload(file, urlInput, statusEl, resourceType) {
    const type = resourceType || 'image';
    if (statusEl) statusEl.textContent = 'Uploading…';
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('upload_preset', this.preset);
      const r = await fetch(
        `https://api.cloudinary.com/v1_1/${this.cloud}/${type}/upload`,
        { method: 'POST', body: fd }
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || `Upload failed (${r.status})`);
      if (urlInput) {
        urlInput.value = data.secure_url;
        urlInput.dispatchEvent(new Event('input'));
      }
      if (statusEl) {
        statusEl.textContent = '✓ Uploaded';
        setTimeout(() => { statusEl.textContent = ''; }, 3000);
      }
      return data.secure_url;
    } catch (err) {
      if (statusEl) statusEl.textContent = '✗ ' + err.message;
      throw err;
    }
  },
};
