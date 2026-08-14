/**
 * Plugin: LaMovie para Nuvio
 * Idioma: Español Latino
 */

const BASE_URL = "https://lamovie.org";
const TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const HEADERS_JSON = {
  "User-Agent": USER_AGENT,
  "Accept": "application/json"
};

const HEADERS_HTML = {
  "User-Agent": USER_AGENT,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "es-MX,es;q=0.9"
};

// --- Petición Auxiliar ---
async function fetchUrl(url, isJson = true) {
  const response = await fetch(url, {
    headers: isJson ? HEADERS_JSON : HEADERS_HTML,
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
  return isJson ? response.json() : response.text();
}

// --- Limpieza de Título para Slugs ---
function toSlug(text, year) {
  if (!text) return "";
  const clean = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return year ? `${clean}-${year}` : clean;
}

// --- Consultar TMDB ---
async function getTMDBInfo(tmdbId, type) {
  try {
    const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&language=es-MX`;
    const data = await fetchUrl(url, true);

    return {
      title: type === "movie" ? data.title : data.name,
      originalTitle: type === "movie" ? data.original_title : data.original_name,
      year: (data.release_date || data.first_air_date || "").substring(0, 4)
    };
  } catch (err) {
    return null;
  }
}

// --- Buscar ID del Post en LaMovie ---
async function findPostId(info, type) {
  const category = type === "movie" ? "peliculas" : "series";
  const slugs = [
    toSlug(info.title, info.year),
    toSlug(info.originalTitle, info.year),
    toSlug(info.title),
    toSlug(info.originalTitle)
  ].filter(Boolean);

  // Eliminar duplicados
  const uniqueSlugs = [...new Set(slugs)];

  for (const slug of uniqueSlugs) {
    try {
      const pageUrl = `${BASE_URL}/${category}/${slug}/`;
      const html = await fetchUrl(pageUrl, false);
      const match = html.match(/rel=['"]shortlink['"]\s+href=['"][^'"]*\?p=(\d+)['"]/);
      if (match) return match[1];
    } catch (e) {
      // Intentar siguiente slug
    }
  }
  return null;
}

// --- Buscar ID de Episodio para Series ---
async function findEpisodePostId(seriesPostId, season, episode) {
  try {
    const apiUrl = `${BASE_URL}/wp-api/v1/single/episodes/list?_id=${seriesPostId}&season=${season}&page=1&postsPerPage=50`;
    const response = await fetchUrl(apiUrl, true);
    if (response?.data?.posts) {
      const ep = response.data.posts.find((p) => p.season_number == season && p.episode_number == episode);
      return ep?._id || null;
    }
  } catch (e) {
    return null;
  }
  return null;
}

// --- Extraer Enlace Directo de GoodStream ---
async function resolveGoodStream(embedUrl) {
  try {
    const html = await fetchUrl(embedUrl, false);
    const match = html.match(/file:\s*"([^"]+)"/);
    if (!match) return null;

    return {
      url: match[1],
      headers: {
        "Referer": embedUrl,
        "Origin": "https://goodstream.one",
        "User-Agent": USER_AGENT
      }
    };
  } catch (e) {
    return null;
  }
}

// --- Extraer Enlace Directo de VOE ---
async function resolveVOE(embedUrl) {
  try {
    let html = await fetchUrl(embedUrl, false);
    const match = html.match(/(?:mp4|hls)["']\s*:\s*["']([^"']+)["']/i);
    if (!match) return null;

    let finalUrl = match[1];
    if (finalUrl.startsWith("aHR0")) {
      try { finalUrl = atob(finalUrl); } catch (e) {}
    }

    return {
      url: finalUrl,
      headers: {
        "Referer": embedUrl,
        "User-Agent": USER_AGENT
      }
    };
  } catch (e) {
    return null;
  }
}

// --- Procesar cada servidor ---
async function processEmbed(embed) {
  const embedUrl = embed.url || "";
  let resolved = null;
  let serverName = "Online";

  if (embedUrl.includes("goodstream")) {
    serverName = "GoodStream";
    resolved = await resolveGoodStream(embedUrl);
  } else if (embedUrl.includes("voe")) {
    serverName = "VOE";
    resolved = await resolveVOE(embedUrl);
  }

  if (!resolved || !resolved.url) return null;

  // Estructura exacta requerida por el reproductor de Nuvio
  return {
    name: "LaMovie",
    title: `720p/1080p · ${serverName}`,
    type: resolved.url.includes(".m3u8") ? "hls" : "url",
    url: resolved.url,
    quality: "HD",
    headers: resolved.headers || {}
  };
}

// ==========================================
// FUNCIÓN PRINCIPAL EXPORTADA PARA NUVIO
// ==========================================

async function getStreams(tmdbId, type, season, episode) {
  if (!tmdbId || !type) return [];

  try {
    // 1. Obtener nombres desde TMDB
    const info = await getTMDBInfo(tmdbId, type);
    if (!info) return [];

    // 2. Encontrar Post ID
    let postId = await findPostId(info, type);
    if (!postId) return [];

    // 3. Si es serie, encontrar el post del episodio
    if (type === "tv" && season && episode) {
      postId = await findEpisodePostId(postId, season, episode);
      if (!postId) return [];
    }

    // 4. Pedir los reproductores a la API de LaMovie
    const playerApi = `${BASE_URL}/wp-api/v1/player?postId=${postId}&demo=0`;
    const playerData = await fetchUrl(playerApi, true);

    if (!playerData?.data?.embeds) return [];

    // 5. Resolver cada reproductor en paralelo
    const promises = playerData.data.embeds.map((embed) => processEmbed(embed));
    const results = await Promise.allSettled(promises);

    // 6. Filtrar los válidos
    const streams = results
      .filter((res) => res.status === "fulfilled" && res.value !== null)
      .map((res) => res.value);

    return streams;

  } catch (error) {
    console.error(`[LaMovie] Error: ${error.message}`);
    return [];
  }
}

// Exportación limpia compatible con Nuvio y Node.js
module.exports = {
  getStreams
};
