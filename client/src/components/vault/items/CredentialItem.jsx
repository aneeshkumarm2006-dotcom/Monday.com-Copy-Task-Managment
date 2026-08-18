import Input from '../../ui/Input';
import SecretField from '../SecretField';

/**
 * Credential — the reason the vault exists. A login, an API key, or both.
 *
 * Every field is optional except the title, because real credentials do not
 * agree on a shape: a database has a host and a password but no URL, an API key
 * has neither a username nor a login page. Requiring a fixed set would push
 * people into the notes field, which is where secrets go to be forgotten.
 */

/**
 * The read view. Secrets are masked and copyable; the URL is openable. Empty
 * fields render nothing at all rather than a row of "—" — see SecretField.
 */
export const CredentialViewer = ({ payload }) => (
  <div>
    <SecretField label="Username" value={payload.username} />
    <SecretField label="Password" value={payload.password} secret />
    <SecretField label="API key" value={payload.apiKey} secret />
    <SecretField label="URL" value={payload.url} href />
    <SecretField label="Notes" value={payload.notes} multiline />
  </div>
);

/**
 * The edit view. Values are shown in the clear here on purpose: masking a field
 * somebody is actively typing into produces the classic "I cannot tell what I
 * mistyped" bug, and they already hold the secret — they are entering it.
 */
export const CredentialEditor = ({ payload, onChange }) => {
  const set = (key) => (e) => onChange({ ...payload, [key]: e.target.value });

  return (
    <div className="flex flex-col gap-4">
      <Input
        label="Title"
        value={payload.title}
        onChange={set('title')}
        placeholder="Stripe — live account"
        required
        autoFocus
      />
      <Input
        label="Username"
        value={payload.username}
        onChange={set('username')}
        placeholder="billing@example.com"
        autoComplete="off"
      />
      <Input
        label="Password"
        value={payload.password}
        onChange={set('password')}
        placeholder="••••••••"
        // The browser's own password manager offering to save a vault secret
        // into a SECOND, unencrypted store would defeat the point.
        autoComplete="off"
        spellCheck={false}
      />
      <Input
        label="API key"
        value={payload.apiKey}
        onChange={set('apiKey')}
        placeholder="sk_live_…"
        autoComplete="off"
        spellCheck={false}
      />
      <Input
        label="URL"
        value={payload.url}
        onChange={set('url')}
        placeholder="https://dashboard.stripe.com"
        autoComplete="off"
      />
      <Input
        label="Notes"
        value={payload.notes}
        onChange={set('notes')}
        placeholder="Which account this is, who owns it, how to rotate it…"
        multiline
        rows={4}
      />
    </div>
  );
};
