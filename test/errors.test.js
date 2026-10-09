import test from 'node:test';
import assert from 'node:assert/strict';
import { humanError } from '../lib/errors.js';

test('codes with a clear cause are mapped one by one', () => {
  assert.equal(humanError({ status: 401 }), 'Сессия истекла. Подключите аккаунт заново.');
  assert.equal(humanError({ status: 403 }), 'Нет доступа к этому виджету. Выберите другой.');
  assert.equal(humanError({ status: 404 }), 'Страница или виджет не найдены.');
  assert.equal(humanError({ status: 400 }), 'Сервер отклонил данные. Проверьте название.');
});

test('all other codes collapse into a single message', () => {
  // 500 and 0 (network down) look the same to the user — both get one text
  assert.equal(humanError({ status: 500 }), 'Не удалось связаться с сервером.');
  assert.equal(humanError({ status: 0 }), 'Не удалось связаться с сервером.');
  assert.equal(humanError(new Error('boom')), 'Не удалось связаться с сервером.');
});

test('status is compared strictly — a string is not treated as the code', () => {
  // ApiError stores a number in status; a string could only arrive by mistake,
  // and showing the generic text is safer than guessing the code
  assert.equal(humanError({ status: '401' }), 'Не удалось связаться с сервером.');
});
