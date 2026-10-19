(() => {
  const normalize = (items = []) => {
    const models = new Map();
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id || item.name || '').trim();
      if (!id || models.has(id)) continue;
      const name = String(item.display_name || item.displayName || item.name || id);
      const size = Number(item.size);
      const details = [item.details?.parameter_size || item.parameter_size, item.details?.quantization_level || item.quantization,
        Number.isFinite(size) && size > 0 ? `${(size / 1024 ** 3).toFixed(1)} GiB` : ''].filter(Boolean).map(String);
      const description = details.join(' · ');
      models.set(id, { id, name, description, label: description ? `${name} — ${description}` : name });
    }
    return [...models.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }) || left.id.localeCompare(right.id));
  };
  globalThis.MoodliaCorrectorModelCatalog = { normalize };
})();
