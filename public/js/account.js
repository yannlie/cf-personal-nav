// 账号自救：修改密码 / 登出全部设备。弹窗原语在 modal.js。
import { api } from './api.js';
import { showToast } from './ui.js';
import { openModal } from './modal.js';

export function openPasswordDialog(onDone) {
  return openModal({
    title: '修改密码',
    description: '修改成功后，其他设备上的登录会立即失效；这台设备会保持登录。',
    fields: [
      {
        key: 'currentPassword',
        label: '当前密码',
        type: 'password',
        autocomplete: 'current-password',
        maxLength: 128,
      },
      {
        key: 'newPassword',
        label: '新密码（至少 8 位）',
        type: 'password',
        autocomplete: 'new-password',
        minLength: 8,
        maxLength: 128,
      },
      {
        key: 'confirmPassword',
        label: '确认新密码',
        type: 'password',
        autocomplete: 'new-password',
        maxLength: 128,
      },
    ],
    submitLabel: '修改密码',
    onSubmit: async (values, setError) => {
      if (!values.currentPassword || !values.newPassword) {
        setError('请填写当前密码和新密码');
        return;
      }
      if (values.newPassword.length < 8) {
        setError('新密码至少 8 位');
        return;
      }
      if (values.newPassword !== values.confirmPassword) {
        setError('两次输入的新密码不一致');
        return;
      }

      await api('/api/password', {
        method: 'POST',
        body: {
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
        },
      });
      showToast('密码已修改，其他设备已退出');
      if (onDone) onDone();
    },
  });
}

export function openLogoutAllDialog(onLoggedOut) {
  return openModal({
    title: '登出全部设备',
    description: '所有设备（包括这一台）都会立即退出登录，密码保持不变。',
    fields: [],
    submitLabel: '全部登出',
    danger: true,
    onSubmit: async () => {
      await api('/api/logout-all', { method: 'POST' });
      showToast('已登出全部设备');
      if (onLoggedOut) onLoggedOut();
    },
  });
}
