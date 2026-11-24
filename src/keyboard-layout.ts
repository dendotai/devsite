// A terminal sends only the character a key types, so on a non-Latin layout the Y key arrives as another letter (`н` on Russian). macOS keeps every layout's key table: this maps each letter the current layout types to the Latin letter of the same key, through UCKeyTranslate, as Zed and Chrome do.
type Koffi = typeof import("koffi").default;

// Empty off macOS, and when koffi or the lookup fails: a prompt then matches the typed key only. koffi is a native module of about 3 MB, so it loads here, when a prompt first asks, never at startup.
export async function latinLettersOfThisMac(): Promise<Map<string, string>> {
  if (process.platform !== "darwin") return new Map();
  try {
    const { default: koffi } = await import("koffi");
    return readLayouts(koffi);
  } catch {
    return new Map();
  }
}

const kUCKeyActionDisplay = 3;
const kUCKeyTranslateNoDeadKeysMask = 1;

function readLayouts(koffi: Koffi): Map<string, string> {
  const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const carbon = koffi.load("/System/Library/Frameworks/Carbon.framework/Carbon");
  const CFDataGetBytePtr = cf.func("void *CFDataGetBytePtr(void *data)");
  const CFRelease = cf.func("void CFRelease(void *ref)");
  const currentSource = carbon.func("void *TISCopyCurrentKeyboardLayoutInputSource()");
  const latinSource = carbon.func("void *TISCopyCurrentASCIICapableKeyboardLayoutInputSource()");
  const property = carbon.func("void *TISGetInputSourceProperty(void *src, void *key)");
  const LMGetKbdType = carbon.func("uint8_t LMGetKbdType()");
  const UCKeyTranslate = carbon.func(
    "int32_t UCKeyTranslate(void *layout, uint16_t keyCode, uint16_t action, uint32_t mods, uint32_t kbdType, uint32_t opts, _Inout_ uint32_t *dead, unsigned long maxLen, _Out_ unsigned long *len, _Out_ uint16_t *chars)",
  );
  // symbol() gives the address of the CFStringRef variable; passing that address as the key crashes, so the value is read first.
  const kLayoutData = koffi.decode(carbon.symbol("kTISPropertyUnicodeKeyLayoutData"), "void *");
  const kbdType = LMGetKbdType();

  const typedBy = (layout: unknown, keyCode: number): string => {
    const chars = new Uint16Array(4);
    const len = [0];
    const err = UCKeyTranslate(
      layout,
      keyCode,
      kUCKeyActionDisplay,
      0,
      kbdType,
      kUCKeyTranslateNoDeadKeysMask,
      [0],
      chars.length,
      len,
      chars,
    );
    return err === 0 ? String.fromCharCode(...chars.subarray(0, len[0])) : "";
  };

  const current = currentSource();
  const latin = latinSource();
  try {
    const currentData = property(current, kLayoutData);
    const latinData = property(latin, kLayoutData);
    // A layout with no key table (some input methods) gives no map.
    if (!currentData || !latinData) return new Map();
    const currentLayout = CFDataGetBytePtr(currentData);
    const latinLayout = CFDataGetBytePtr(latinData);
    const map = new Map<string, string>();
    for (let keyCode = 0; keyCode < 128; keyCode++) {
      const typed = typedBy(currentLayout, keyCode);
      const letter = typedBy(latinLayout, keyCode);
      if (typed && typed !== letter && /^[a-z]$/.test(letter)) map.set(typed, letter);
    }
    return map;
  } finally {
    CFRelease(current);
    CFRelease(latin);
  }
}
