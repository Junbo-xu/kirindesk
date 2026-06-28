import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api-client';
import { ApiError, NotificationSettings } from '../lib/types';

export function NotificationSettingsPage() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiClient
      .getNotificationSettings()
      .then(setSettings)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 403) {
          setError('没有权限查看通知设置');
        } else {
          setError(e instanceof Error ? e.message : '加载失败');
        }
      });
  }, []);

  async function toggle(key: keyof Omit<NotificationSettings, 'tenantId'>) {
    if (!settings || saving) return;
    setSaving(true);
    try {
      const updated = await apiClient.updateNotificationSettings({ [key]: !settings[key] });
      setSettings(updated);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  if (error) return <p style={{ color: 'crimson' }}>{error}</p>;
  if (!settings) return <p>加载中…</p>;

  const rows: { key: keyof Omit<NotificationSettings, 'tenantId'>; label: string }[] = [
    { key: 'orderEvents', label: '订单审批通知' },
    { key: 'userWelcome', label: '用户欢迎邮件' },
    { key: 'supportAccess', label: '支持访问通知' },
  ];

  return (
    <div style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: 20 }}>通知设置</h1>
      <p style={{ color: '#666', fontSize: 13 }}>开启后，相关事件将通过邮件通知相关用户。</p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map(({ key, label }) => (
            <tr key={key} style={{ borderBottom: '1px solid #e5e7eb' }}>
              <td style={{ padding: '12px 4px', fontSize: 14 }}>{label}</td>
              <td style={{ padding: '12px 4px', textAlign: 'right' }}>
                <input
                  type="checkbox"
                  checked={settings[key]}
                  disabled={saving}
                  onChange={() => void toggle(key)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {saving && <p style={{ fontSize: 13, color: '#888', marginTop: 8 }}>保存中…</p>}
    </div>
  );
}
