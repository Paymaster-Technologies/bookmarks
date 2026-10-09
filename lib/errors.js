/**
 * Human-readable text for an error.
 *
 * Only status is inspected. Anything not in the list collapses into
 * one phrase — telling "network unavailable" from "server down" is useless to
 * the user.
 */
export function humanError(error) {
  if (error.status === 401) return 'Сессия истекла. Подключите аккаунт заново.';
  if (error.status === 403) return 'Нет доступа к этому виджету. Выберите другой.';
  if (error.status === 404) return 'Страница или виджет не найдены.';
  if (error.status === 400) return 'Сервер отклонил данные. Проверьте название.';
  return 'Не удалось связаться с сервером.';
}
