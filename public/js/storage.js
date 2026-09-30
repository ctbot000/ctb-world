// localStorage with an in-memory copy: storage can be unavailable (private
// windows, blocked cookies), and a failed write must not make the next read
// contradict what the session just did.

const memory = new Map();
const PREFIX = 'ctbworld.';

export function load(key, fallback = null) {
  if (memory.has(key)) return memory.get(key);
  let value = fallback;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw !== null) value = JSON.parse(raw);
  } catch {
    // unavailable or corrupt: use the fallback
  }
  memory.set(key, value);
  return value;
}

export function save(key, value) {
  memory.set(key, value);
  try {
    if (value === null || value === undefined) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
