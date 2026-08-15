import { FormEvent, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import QRCode from "qrcode";
import { api, ApiError } from "../api";
import ErrorBanner from "../components/ErrorBanner";

type Step = "phone" | "code" | "password";

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  // QR login runs alongside the phone form: a background poll checks
  // whether the code has been scanned, while the user is free to fill in
  // the phone form instead. Only active on the initial step — once the
  // user has committed to the phone flow (moved to "code"), stop polling
  // so a stray scan can't jump the step out from under them.
  useEffect(() => {
    if (step !== "phone") return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    async function beginQr() {
      try {
        const res = await api.auth.qrLoginStart();
        if (cancelled) return;
        setQrUrl(res.url);
        setQrError(null);
      } catch (err) {
        if (!cancelled) setQrError(err instanceof ApiError ? err.message : "Failed to start QR login");
      }
    }

    async function poll() {
      try {
        const res = await api.auth.qrLoginPoll();
        if (cancelled) return;
        if (res.status === "authorized") onSuccess();
        else if (res.status === "needs_password") setStep("password");
        else if (res.status === "expired") beginQr();
        else if (res.status === "error") setQrError(res.error || "QR login failed");
      } catch {
        // transient network hiccup — next tick retries
      }
    }

    beginQr();
    pollTimer = setInterval(poll, 1500);

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => {
    if (!qrUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(qrUrl, { width: 220, margin: 1 }).then((data) => {
      if (!cancelled) setQrDataUrl(data);
    });
    return () => {
      cancelled = true;
    };
  }, [qrUrl]);

  async function submitPhone(e: FormEvent) {
    e.preventDefault();
    if (!phone.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.sendCode(phone.trim());
      setStep("code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to send code");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.auth.signIn(code.trim());
      if (res.needsPassword) {
        setStep("password");
      } else {
        onSuccess();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to sign in");
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (!password.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.signInPassword(password.trim());
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className={`w-full flex flex-col gap-6 ${step === "phone" ? "max-w-2xl" : "max-w-sm"}`}>
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="text-3xl" aria-hidden="true">🐼</span>
          <h1 className="text-xl font-semibold">Panda Vault</h1>
          <p className="text-sm text-panda-muted flex items-center gap-1.5">
            <ShieldCheck size={14} /> One-time Telegram login to activate this instance
          </p>
        </div>

        {error && <ErrorBanner message={error} />}

        {step === "phone" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-stretch">
            <form onSubmit={submitPhone} className="flex flex-col gap-3 rounded-lg border border-panda-border bg-panda-surface p-4">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-panda-muted">Phone number</span>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 555 123 4567"
                  autoFocus
                  className="bg-panda-surface2 border border-panda-border rounded-lg px-3 py-2 outline-none focus:border-panda-accent"
                />
              </label>
              <p className="text-xs text-panda-muted">
                Enter your Telegram account's phone number. We'll send a login code to your Telegram app (or by SMS).
              </p>
              <button
                type="submit"
                disabled={busy}
                className="mt-auto px-3 py-2 text-sm rounded-lg bg-panda-accent text-panda-bg font-medium hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Sending…" : "Send code"}
              </button>
            </form>

            <div className="flex flex-col gap-3 items-center text-center rounded-lg border border-panda-border bg-panda-surface p-4">
              <span className="self-start text-sm text-panda-muted">Or scan a QR code</span>
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="QR login code" className="w-40 h-40 rounded-md bg-white p-2" />
              ) : (
                <div className="w-40 h-40 flex items-center justify-center rounded-md bg-panda-surface2 text-xs text-panda-muted">
                  {qrError ? "Unavailable" : "Loading…"}
                </div>
              )}
              <p className="text-xs text-panda-muted">
                Open Telegram → Settings → Devices → Link Desktop Device, then scan this code.
              </p>
              {qrError && <p className="text-xs text-red-400">{qrError}</p>}
            </div>
          </div>
        )}

        {step === "code" && (
          <form onSubmit={submitCode} className="flex flex-col gap-3 rounded-lg border border-panda-border bg-panda-surface p-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-panda-muted">Login code</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="12345"
                autoFocus
                inputMode="numeric"
                className="bg-panda-surface2 border border-panda-border rounded-lg px-3 py-2 outline-none focus:border-panda-accent font-mono"
              />
            </label>
            <p className="text-xs text-panda-muted">Sent to {phone.trim()} via Telegram.</p>
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-2 text-sm rounded-lg bg-panda-accent text-panda-bg font-medium hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Verify"}
            </button>
          </form>
        )}

        {step === "password" && (
          <form onSubmit={submitPassword} className="flex flex-col gap-3 rounded-lg border border-panda-border bg-panda-surface p-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-panda-muted">Two-factor password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                className="bg-panda-surface2 border border-panda-border rounded-lg px-3 py-2 outline-none focus:border-panda-accent"
              />
            </label>
            <p className="text-xs text-panda-muted">This account has two-factor authentication enabled.</p>
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-2 text-sm rounded-lg bg-panda-accent text-panda-bg font-medium hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Sign in"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
