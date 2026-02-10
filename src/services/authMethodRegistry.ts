export type AuthMethodDescriptor = {
  key: 'password' | 'telegram';
  label: string;
  enabled: boolean;
  flow: 'credentials' | 'telegram';
};

type AuthMethodProvider = {
  key: AuthMethodDescriptor['key'];
  label: string;
  flow: AuthMethodDescriptor['flow'];
  isEnabled: () => boolean;
};

const AUTH_METHOD_PROVIDERS: AuthMethodProvider[] = [
  {
    key: 'password',
    label: 'Email и пароль',
    flow: 'credentials',
    isEnabled: () => true,
  },
  {
    key: 'telegram',
    label: 'Telegram',
    flow: 'telegram',
    isEnabled: () =>
      Boolean(
        String(process.env.TELEGRAM_BOT_TOKEN || '').trim() &&
          String(process.env.TELEGRAM_BOT_USERNAME || '').trim()
      ),
  },
];

export function getAuthMethodDescriptors(): AuthMethodDescriptor[] {
  return AUTH_METHOD_PROVIDERS.map((provider) => ({
    key: provider.key,
    label: provider.label,
    flow: provider.flow,
    enabled: provider.isEnabled(),
  }));
}
