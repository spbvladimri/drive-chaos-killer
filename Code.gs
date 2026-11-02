/**
 * DRIVE CHAOS KILLER
 *
 * Организация файлов в "Моём диске".
 *
 * По умолчанию включён проверочный режим.
 * Для настоящего переноса установите PREVIEW: false.
 *
 * ВАЖНО:
 * Перенос меняет расположение файлов.
 * Пустые исходные папки отправляются в корзину.
 * Автоматического отката нет.
 */

const SETTINGS = {
  // true — только показать план.
  // false — перемещать файлы и убирать пустые папки.
  PREVIEW: true,

  // Эти папки и их содержимое не трогаем.
  // Название проверяется без учёта регистра
  // и пробелов по краям.
  EXCLUDED: ['Архив', 'TrustWalletBackup'],

  // Ограничение времени одного запуска.
  MAX_MS: 4 * 60 * 1000,

  CATEGORIES: [
    'Фото',
    'Видео',
    'Аудио',
    'Документы',
    'Таблицы',
    'Презентации',
    'Формы',
    'Программы',
    'Архивы ZIP RAR',
    'Остальное'
  ]
};

function sortMyDrive() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    console.log('Другой запуск этого проекта ещё работает.');
    return;
  }

  try {
    const started = Date.now();
    const root = DriveApp.getRootFolder();
    const email = Session.getEffectiveUser().getEmail();

    if (!email) {
      throw new Error(
        'Не удалось определить аккаунт. Запуск отменён.'
      );
    }

    const normalize = value => value.trim().toLowerCase();

    const excluded = new Set(
      SETTINGS.EXCLUDED.map(normalize)
    );

    const categoryNames = new Set(
      SETTINGS.CATEGORIES.map(normalize)
    );

    const targets = {};
    const folderCache = new Map();
    const counts = {};

    let processed = 0;
    let cleaned = 0;
    let skipped = 0;
    let errors = 0;
    let stopped = false;

    function timeUp() {
      if (Date.now() - started >= SETTINGS.MAX_MS) {
        stopped = true;
        return true;
      }

      return false;
    }

    function isMine(item) {
      const owner = item.getOwner();

      return Boolean(
        owner &&
        normalize(owner.getEmail()) === normalize(email)
      );
    }

    // Сначала проверяем корневые категории.
    // На этом этапе ничего не перемещается.
    const rootFolders = [];
    const rootIterator = root.getFolders();

    while (rootIterator.hasNext()) {
      if (timeUp()) {
        throw new Error(
          'Не хватило времени на начальную проверку. ' +
          'Ничего не перемещено.'
        );
      }

      rootFolders.push(rootIterator.next());
    }

    for (const category of SETTINGS.CATEGORIES) {
      if (excluded.has(normalize(category))) {
        throw new Error(
          `Категория "${category}" одновременно указана ` +
          'в исключениях. Исправьте настройки.'
        );
      }

      const matches = rootFolders.filter(folder =>
        normalize(folder.getName()) === normalize(category)
      );

      if (matches.length > 1) {
        throw new Error(
          `В корне несколько папок "${category}". ` +
          'Переименуйте лишние перед запуском.'
        );
      }

      if (matches.length === 1) {
        if (!isMine(matches[0])) {
          throw new Error(
            `Папка назначения "${category}" принадлежит ` +
            'другому владельцу. Запуск отменён.'
          );
        }

        targets[category] = matches[0];
      }
    }

    function categoryFolder(category) {
      if (!targets[category]) {
        targets[category] = root.createFolder(category);
      }

      return targets[category];
    }

    function childFolder(parent, name) {
      const key = JSON.stringify([parent.getId(), name]);

      if (folderCache.has(key)) {
        return folderCache.get(key);
      }

      const iterator = parent.getFoldersByName(name);
      let folder;

      if (iterator.hasNext()) {
        folder = iterator.next();

        if (iterator.hasNext()) {
          throw new Error(
            `В "${parent.getName()}" несколько подпапок ` +
            `"${name}". Нужна ручная проверка.`
          );
        }

        if (!isMine(folder)) {
          throw new Error(
            `Подпапка назначения "${name}" принадлежит ` +
            'другому владельцу.'
          );
        }
      } else {
        folder = parent.createFolder(name);
      }

      folderCache.set(key, folder);
      return folder;
    }

    function getRoute(file, sourceParts) {
      const mime = file.getMimeType();
      const category = classify(file.getName(), mime);

      let parts = [];

      if (category === 'Фото' || category === 'Видео') {
        parts = sourceParts.length
          ? sourceParts.slice()
          : ['Из корня диска'];
      }

      if (category === 'Документы') {
        parts = [
          documentSubtype(file.getName(), mime)
        ];
      }

      return { category, parts };
    }

    function processFiles(folder, sourceParts, documentsOnly) {
      const files = folder.getFiles();

      while (files.hasNext()) {
        if (timeUp()) return;

        const file = files.next();

        try {
          const mime = file.getMimeType();

          // Не перемещаем ярлыки, проекты Apps Script
          // и файлы других владельцев.
          if (
            mime === 'application/vnd.google-apps.shortcut' ||
            mime === 'application/vnd.google-apps.script' ||
            !isMine(file)
          ) {
            skipped++;
            continue;
          }

          const route = getRoute(file, sourceParts);

          if (
            documentsOnly &&
            route.category !== 'Документы'
          ) {
            skipped++;
            continue;
          }

          const targetPath = [route.category]
            .concat(route.parts)
            .join('/');

          const sourcePath = ['Мой диск']
            .concat(sourceParts, file.getName())
            .join('/');

          if (!SETTINGS.PREVIEW) {
            let target = categoryFolder(route.category);

            for (const part of route.parts) {
              if (timeUp()) return;

              target = childFolder(target, part);
            }

            if (timeUp()) return;

            file.moveTo(target);
          }

          processed++;

          counts[route.category] =
            (counts[route.category] || 0) + 1;

          console.log(
            `${SETTINGS.PREVIEW ? 'ПЛАН' : 'ПЕРЕМЕЩЕНО'}: ` +
            `${sourcePath} → ${targetPath}`
          );
        } catch (error) {
          errors++;

          console.log(
            `ОШИБКА ФАЙЛА: ${file.getName()} — ` +
            error.message
          );
        }
      }
    }

    function walk(folder, sourceParts, isRoot) {
      if (timeUp()) return;

      const path = ['Мой диск']
        .concat(sourceParts)
        .join('/');

      // Исключения действуют на любой глубине.
      if (
        !isRoot &&
        excluded.has(normalize(folder.getName()))
      ) {
        console.log('ПРОПУСК ПАПКИ: ' + path);
        return;
      }

      if (!isRoot && !isMine(folder)) {
        skipped++;

        console.log('ПРОПУСК ЧУЖОЙ ПАПКИ: ' + path);
        return;
      }

      processFiles(folder, sourceParts, false);

      if (stopped) return;

      const children = folder.getFolders();

      while (children.hasNext()) {
        if (timeUp()) return;

        const child = children.next();

        // Корневые категории используются как назначения.
        // Их содержимое рекурсивно не сортируем.
        if (
          isRoot &&
          categoryNames.has(normalize(child.getName()))
        ) {
          continue;
        }

        try {
          walk(
            child,
            sourceParts.concat(child.getName()),
            false
          );
        } catch (error) {
          errors++;

          console.log(
            `ОШИБКА ПАПКИ: ${path}/${child.getName()} — ` +
            error.message
          );
        }

        if (stopped) return;
      }

      // Убираем только действительно пустые исходные папки.
      // Очистка идёт снизу вверх.
      if (
        !isRoot &&
        !SETTINGS.PREVIEW &&
        !timeUp() &&
        !folder.getFiles().hasNext() &&
        !folder.getFolders().hasNext() &&
        isMine(folder)
      ) {
        folder.setTrashed(true);
        cleaned++;

        console.log(
          'ПУСТАЯ ПАПКА В КОРЗИНУ: ' + path
        );
      }
    }

    console.log(
      SETTINGS.PREVIEW
        ? 'ПРОВЕРКА: изменения отключены.'
        : 'НАСТОЯЩИЙ ПЕРЕНОС: изменения включены.'
    );

    // Дополнительно разбираем документы, которые уже лежат
    // непосредственно в корне папки "Документы".
    if (targets['Документы']) {
      processFiles(
        targets['Документы'],
        ['Документы'],
        true
      );
    }

    if (!stopped) {
      walk(root, [], true);
    }

    console.log('ИТОГ: ' + JSON.stringify(counts));

    console.log(
      `${SETTINGS.PREVIEW ? 'Запланировано' : 'Перемещено'} ` +
      'файлов: ' + processed
    );

    console.log(
      'Пустых папок отправлено в корзину: ' + cleaned
    );

    console.log('Пропущено объектов: ' + skipped);
    console.log('Ошибок: ' + errors);

    if (stopped) {
      console.log(
        'ОСТАНОВКА ПО ВРЕМЕНИ. ' +
        'В режиме переноса запустите sortMyDrive повторно ' +
        'для оставшихся файлов. ' +
        'В проверочном режиме проверка снова начнётся с начала.'
      );
    } else {
      console.log(
        'ОБХОД ЗАВЕРШЁН. ' +
        'Проверьте итог и сообщения об ошибках.'
      );
    }
  } finally {
    lock.releaseLock();
  }
}

function extensionOf(name) {
  return name.includes('.')
    ? name.split('.').pop().toLowerCase()
    : '';
}

function classify(name, mime) {
  const ext = extensionOf(name);

  // Установщики проверяем раньше архивов.
  if (
    /^(apk|apks|aab|xapk|exe|msi|msix|appx|dmg|pkg|deb|rpm|appimage)$/.test(ext)
  ) {
    return 'Программы';
  }

  // EPUB проверяем раньше ZIP-архивов.
  if (
    /^(epub|fb2)$/.test(ext) ||
    mime === 'application/epub+zip'
  ) {
    return 'Документы';
  }

  if (mime.startsWith('image/')) return 'Фото';
  if (mime.startsWith('video/')) return 'Видео';
  if (mime.startsWith('audio/')) return 'Аудио';

  if (
    /^(jpg|jpeg|png|gif|webp|heic|heif|bmp|tif|tiff|svg|avif|dng|cr2|cr3|nef|arw)$/.test(ext)
  ) {
    return 'Фото';
  }

  if (
    /^(mp4|mov|avi|mkv|webm|m4v|3gp|mts|m2ts|wmv|mpg|mpeg)$/.test(ext)
  ) {
    return 'Видео';
  }

  if (
    /^(mp3|wav|flac|aac|m4a|ogg|opus|wma|aiff)$/.test(ext)
  ) {
    return 'Аудио';
  }

  if (
    mime === 'application/vnd.google-apps.spreadsheet' ||
    /^(xls|xlsx|xlsm|ods|csv|tsv)$/.test(ext)
  ) {
    return 'Таблицы';
  }

  if (
    mime === 'application/vnd.google-apps.presentation' ||
    /^(ppt|pptx|pptm|odp)$/.test(ext)
  ) {
    return 'Презентации';
  }

  if (mime === 'application/vnd.google-apps.form') {
    return 'Формы';
  }

  if (
    mime === 'application/vnd.google-apps.document' ||
    mime === 'application/pdf' ||
    mime === 'application/msword' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/vnd.oasis.opendocument.text' ||
    mime === 'application/rtf' ||
    mime.startsWith('text/') ||
    /^(doc|docx|odt|rtf|txt|md|markdown|pdf)$/.test(ext)
  ) {
    return 'Документы';
  }

  if (
    /^(zip|rar|7z|tar|gz|bz2|xz|tgz)$/.test(ext) ||
    /zip|compressed|archive|x-tar/i.test(mime)
  ) {
    return 'Архивы ZIP RAR';
  }

  return 'Остальное';
}

function documentSubtype(name, mime) {
  const ext = extensionOf(name);

  if (mime === 'application/vnd.google-apps.document') {
    return 'Google Документы';
  }

  if (mime === 'application/pdf' || ext === 'pdf') {
    return 'PDF';
  }

  if (
    /^(doc|docx)$/.test(ext) ||
    mime === 'application/msword' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'Word';
  }

  if (
    ext === 'odt' ||
    mime === 'application/vnd.oasis.opendocument.text'
  ) {
    return 'OpenDocument';
  }

  if (
    /^(epub|fb2)$/.test(ext) ||
    mime === 'application/epub+zip'
  ) {
    return 'Электронные книги';
  }

  if (
    /^(txt|rtf|md|markdown)$/.test(ext) ||
    mime === 'text/plain' ||
    mime === 'text/markdown' ||
    mime === 'application/rtf'
  ) {
    return 'Текстовые';
  }

  return 'Другие документы';
}