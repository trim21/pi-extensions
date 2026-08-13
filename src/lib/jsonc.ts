/**
 * Minimal JSONC → JSON conversion for small user-edited config files.
 *
 * Strips line and block comments and trailing commas outside of string
 * literals, so a stray comment in a config file does not silently void the
 * whole file (the way a plain `JSON.parse` would).
 */

export function jsoncToJson(raw: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < raw.length) {
        out += raw[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    switch (c) {
      case '"': {
        inString = true;
        out += c;
        i++;
        continue;
      }
      case "/": {
        if (raw[i + 1] === "/") {
          while (i < raw.length && raw[i] !== "\n") i++;
          continue;
        }
        if (raw[i + 1] === "*") {
          i += 2;
          while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
          i += 2;
          continue;
        }
        out += c;
        i++;
        continue;
      }
      case ",": {
        // Drop a trailing comma before } or ] (outside strings).
        let j = i + 1;
        while (j < raw.length && /\s/.test(raw[j])) j++;
        if (raw[j] === "}" || raw[j] === "]") {
          i++;
          continue;
        }
        out += c;
        i++;
        continue;
      }
      default: {
        out += c;
        i++;
      }
    }
  }
  return out;
}
