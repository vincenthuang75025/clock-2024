(() => {
  const specificLocale = (/\?(.*)\blang=([^&]+)/.exec(window.location.href) || [])[2];
  const urlLocale = (/\borloj\/([^/]+)/.exec(window.location.href) || [])[1];
  let locales = [];

  if (navigator.languages)
    locales = navigator.languages;
  else if (navigator.language)
    locales = [navigator.language];

  if (specificLocale)
    locales = [specificLocale];
  else if (urlLocale) {
    let matched = false;

    for (const locale of locales) {
      if (locale.startsWith(urlLocale)) {
        locales = [locale];
        matched = true;
        break;
      }
    }

    if (!matched)
      locales = [urlLocale];
  }
})();
