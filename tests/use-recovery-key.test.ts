import { describe, expect, it } from "vitest";
import { nextTick, ref } from "vue";
import { useRecoveryKey, type RecoveryKeyMaterial } from "../app/composables/useRecoveryKey";

const KEY = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const OTHER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const SECRET = `0x${"ab".repeat(32)}`;

/** Several microtasks: the eager derive and the auto-reveal both run off watchers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await nextTick();
}

const material = (address: string): RecoveryKeyMaterial => ({ address, secret: SECRET });

describe("useRecoveryKey", () => {
  it("withholds the key when the derivation disagrees with the recorded address", async () => {
    const key = useRecoveryKey({
      known: () => KEY,
      resolve: () => material(OTHER),
    });
    await flush();
    await key.toggle();

    expect(key.secret.value).toBeNull();
    expect(key.masked.value).toBe(true);
    expect(key.unavailable.value).toBe(true);
    // The address the record vouches for still stands; only the secret is held back.
    expect(key.address.value).toBe(KEY);
    expect(key.material.value).toBe(true);
  });

  it("reveals the key when the derivation agrees", async () => {
    const key = useRecoveryKey({ known: () => KEY, resolve: () => material(KEY) });
    await flush();
    await key.toggle();

    expect(key.secret.value).toBe(SECRET);
    expect(key.masked.value).toBe(false);
    expect(key.unavailable.value).toBe(false);
  });

  it("clears the unavailable notice once a later tap succeeds", async () => {
    let fail = true;
    const key = useRecoveryKey({
      known: () => KEY,
      resolve: () => {
        if (fail) throw new Error("no entropy root");
        return material(KEY);
      },
    });
    await flush();
    await key.toggle();
    expect(key.unavailable.value).toBe(true);

    fail = false;
    await key.toggle();

    expect(key.unavailable.value).toBe(false);
    expect(key.secret.value).toBe(SECRET);
    expect(key.masked.value).toBe(false);
  });

  it("derives up front only when nothing else can supply the address", async () => {
    let calls = 0;
    const known = useRecoveryKey({
      known: () => KEY,
      resolve: () => {
        calls++;
        return material(KEY);
      },
    });
    await flush();
    expect(calls).toBe(0);
    expect(known.address.value).toBe(KEY);

    const blind = useRecoveryKey({ known: () => null, resolve: () => material(OTHER) });
    await flush();
    // The address arrives without a tap; the secret still waits for one.
    expect(blind.address.value).toBe(OTHER);
    expect(blind.masked.value).toBe(true);
    expect(blind.secret.value).toBeNull();
  });

  it("says so when there is nothing to show at all", async () => {
    const key = useRecoveryKey({ known: () => null, resolve: () => null });
    await flush();

    expect(key.address.value).toBeNull();
    expect(key.material.value).toBe(false);
    expect(key.unavailable.value).toBe(true);
  });

  it("reveals without a tap when the preview flag flips after setup", async () => {
    const want = ref(false);
    const key = useRecoveryKey({
      known: () => KEY,
      autoReveal: () => want.value,
      resolve: () => material(KEY),
    });
    await flush();
    expect(key.masked.value).toBe(true);

    want.value = true;
    await flush();

    expect(key.masked.value).toBe(false);
    expect(key.secret.value).toBe(SECRET);

    // Stepping back off the revealed frame puts it away again.
    want.value = false;
    await flush();

    expect(key.masked.value).toBe(true);
    expect(key.secret.value).toBeNull();
  });

  it("drops the held key when another request takes the screen", async () => {
    const label = ref("wd:eph:dot:1");
    const key = useRecoveryKey({
      identity: () => label.value,
      known: () => KEY,
      resolve: () => material(KEY),
    });
    await flush();
    await key.toggle();
    expect(key.secret.value).toBe(SECRET);

    label.value = "wd:eph:dot:2";
    await flush();

    expect(key.secret.value).toBeNull();
    expect(key.masked.value).toBe(true);
  });

  it("re-reveals a staged scene when the key under it changes", async () => {
    const label = ref("wd:eph:dot:1");
    const key = useRecoveryKey({
      identity: () => label.value,
      known: () => KEY,
      autoReveal: () => true,
      resolve: () => material(KEY),
    });
    await flush();
    expect(key.masked.value).toBe(false);

    label.value = "wd:eph:dot:2";
    await flush();

    expect(key.masked.value).toBe(false);
    expect(key.secret.value).toBe(SECRET);
  });
});
