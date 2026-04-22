

const CLOAKS = {
  google:    { title: "Google",            favicon: "https://www.google.com/favicon.ico" },
  classroom: { title: "Google Classroom",  favicon: "https://classroom.google.com/favicon.ico" },
  drive:     { title: "Google Drive",      favicon: "https://ssl.gstatic.com/docs/doclist/images/drive_2022q3_32dp.png" },
  canvas:    { title: "Dashboard",         favicon: "https://du11hjcvx0uqb.cloudfront.net/dist/images/favicon-e10d657a73.ico" },
  khan:      { title: "Khan Academy",      favicon: "https://cdn.kastatic.org/images/favicon.ico?logo" },
  none:      null,
};

let currentCloak = localStorage.getItem("blossom-cloak") || "google";

export function applyCloak(name) {
  if (name) {
    currentCloak = name;
    localStorage.setItem("blossom-cloak", name);
  }

  const cloak = CLOAKS[currentCloak];
  if (!cloak) {

    document.title = "Blossom";
    setFavicon(null);
    return;
  }

  document.title = cloak.title;
  setFavicon(cloak.favicon);
}

export function getCurrentCloak() {
  return currentCloak;
}

function setFavicon(url) {
  let link = document.querySelector("link[rel*='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = url || "";
}

export function launchAboutBlankCloak() {
  const isFirefox = navigator.userAgent.includes("Firefox");
  if (isFirefox) {
    alert("about:blank cloaking doesn't work on Firefox. Use tab cloaking instead.");
    return;
  }

  const popup = window.open("about:blank", "_blank");
  if (!popup) {
    alert("Popup blocked! Allow popups for this site and try again.");
    return;
  }

  const cloak = CLOAKS[currentCloak];
  const title = (cloak?.title || "Google").replace(/[<>&"']/g, "");
  const favicon = (cloak?.favicon || "https://www.google.com/favicon.ico").replace(/[<>&"']/g, "");
  const src = location.href.replace(/"/g, "&quot;");

  const doc = popup.document;
  doc.open();
  doc.write(`<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
  <link rel="icon" href="${favicon}" />
  <style>body{margin:0;overflow:hidden}iframe{width:100vw;height:100vh;border:none}</style>
</head>
<body>
  <iframe src="${src}"></iframe>
</body>
</html>`);
  doc.close();

  window.close();
}
