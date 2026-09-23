// 通用模态框原语：自建，不依赖 <dialog>，也不依赖任何库。
// 账号操作、查看备注等都基于这里。

// fields 为 [{ key, label, type, autocomplete, minLength, maxLength, placeholder }]
// onSubmit(values, setError)：抛错或调用 setError 都会停在弹窗里等用户修改。
export function openModal(options) {
  const {
    title,
    description = '',
    fields = [],
    submitLabel = '确定',
    cancelLabel = '取消',
    hideCancel = false,
    danger = false,
    onSubmit,
  } = options;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const panel = document.createElement('form');
    panel.className = 'modal-panel';
    // 阻止原生表单提交（提交按钮本身会走下面的 click 逻辑）
    panel.addEventListener('submit', (event) => event.preventDefault());

    const heading = document.createElement('h2');
    heading.textContent = title;
    panel.append(heading);

    if (description) {
      const text = document.createElement('p');
      text.className = 'modal-desc';
      text.textContent = description;
      panel.append(text);
    }

    const inputs = new Map();
    for (const field of fields) {
      const wrap = document.createElement('div');
      wrap.className = 'field';

      const label = document.createElement('label');
      label.textContent = field.label;

      const input = document.createElement('input');
      input.type = field.type || 'text';
      if (field.autocomplete) input.autocomplete = field.autocomplete;
      if (field.minLength) input.minLength = field.minLength;
      if (field.maxLength) input.maxLength = field.maxLength;
      if (field.placeholder) input.placeholder = field.placeholder;

      wrap.append(label, input);
      panel.append(wrap);
      inputs.set(field.key, input);
    }

    const error = document.createElement('p');
    error.className = 'modal-error';
    panel.append(error);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = danger ? 'danger-btn' : 'primary-btn';
    submit.textContent = submitLabel;

    if (!hideCancel) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'secondary-btn';
      cancel.textContent = cancelLabel;
      cancel.addEventListener('click', () => close(false));
      actions.append(cancel);
    }

    actions.append(submit);
    panel.append(actions);

    function close(result) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }

    function onKey(event) {
      if (event.key === 'Escape') close(false);
    }

    submit.addEventListener('click', async () => {
      const values = {};
      for (const [key, input] of inputs) values[key] = input.value;

      submit.disabled = true;
      error.textContent = '';
      // setError 被调用说明是校验没过：要停在弹窗里让用户改，
      // 不能因为 onSubmit 正常返回就把弹窗关掉。
      let invalid = false;
      const setError = (message) => {
        invalid = true;
        error.textContent = message;
      };

      try {
        await onSubmit(values, setError);
        if (!invalid) close(true);
      } catch (err) {
        error.textContent = err && err.message ? err.message : '操作失败';
      } finally {
        submit.disabled = false;
      }
    });

    // 点遮罩空白处关闭
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(false);
    });

    document.addEventListener('keydown', onKey);
    overlay.append(panel);
    document.body.append(overlay);

    const first = inputs.values().next().value;
    if (first) first.focus();
  });
}

// 只读信息弹窗（例如查看站点备注）：只有正文和一个关闭按钮。
export function openInfoDialog({ title, text, closeLabel = '关闭' }) {
  return openModal({
    title,
    description: text,
    fields: [],
    hideCancel: true,
    submitLabel: closeLabel,
    onSubmit: async () => {},
  });
}
