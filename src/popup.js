const api = globalThis.browser ?? globalThis.chrome;

init();

async function init() {
  const enabled = document.querySelector("#enabled");
  const status = document.querySelector("#status");
  const response = await api.runtime.sendMessage({ type: "GET_SETTINGS" });
  const settings = response?.settings || {};

  enabled.checked = settings.enabled;
  status.textContent = formatActiveModelStatus(settings);

  enabled.addEventListener("change", async () => {
    await api.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: { enabled: enabled.checked } });
    status.textContent = enabled.checked ? "AskLocal is enabled on X." : "AskLocal is disabled.";
  });

  document.querySelector("#options").addEventListener("click", async () => {
    const opened = await api.runtime.sendMessage({ type: "OPEN_ASKLOCAL_PAGE", payload: { view: "settings" } }).catch(() => null);
    if (!opened?.ok) {
      api.runtime.sendMessage({ type: "OPEN_OPTIONS" });
    }
  });
}

function formatActiveModelStatus(settings) {
  const models = Array.isArray(settings.models) ? settings.models : [];
  const active = models.find((entry) => entry.id === settings.activeMainModelId)
    || models.find((entry) => entry.usableAsMainText)
    || null;
  if (active?.name) return active.name;
  if (settings.provider && settings.model) return `${settings.provider} - ${settings.model}`;
  return "AskLocal";
}
