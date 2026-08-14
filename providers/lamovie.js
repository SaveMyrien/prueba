/**
 * Provider: LaMovie para Nuvio
 * Soporta: Películas y Series en Español Latino
 */

// Constantes y Configuración
const BASE_URL = "https://lamovie.org"; // Si cambia el dominio, sólo actualiza esta línea
const TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const HEADERS_JSON = {
  "User-Agent": USER_AGENT,
  "Accept": "application/json"
};

const HEADERS_HTML = {
  "User-Agent": USER_AGENT,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "es-MX,es;q=0.9",
  "Connection": "keep-alive"
};

// Mapas de resoluciones predefinidas por servidor
const QUALITY_MAPS = {
  vimeos: { h: "720p", n: "480p" },
  goodstream: { x: "1080p", h: "720p", n: "480p", l: "360p" },
  vidhide: { n: "720p", l: "480p" },
  streamwish: { x: "1080p", h: "1080p", n: "720p", l: "480p" },
  voe: { n: "720p", l: "360p" }
};

const PRIORITY_KEYS = ["x", "o", "h", "n", "l"];
const ANIME_GENRE_ID = 16;
const ASIAN_COUNTRIES = ["JP", "CN", "KR"];

// ==========================================
// UTILIDADES
// ==========================================

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { ...HEADERS_JSON, ...options.headers },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`HTTP Error ${response.status} en ${url}`);
  }

  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("json") ? response.json() : response.text();
}

function normalizeSlug(text, year) {
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

function detectQualityFromUrl(url) {
  if (!url) return "Unknown";

  let matchedMap = null;
  if (url.includes("vimeos")) matchedMap = QUALITY_MAPS.vimeos;
  else if (url.includes("goodstream")) matchedMap = QUALITY_MAPS.goodstream;
  else if (url.includes("cloudwindow-route")) matchedMap = QUALITY_MAPS.voe;
  else if (url.includes("vidhide") || url.includes("dintezuvio")) matchedMap = QUALITY_MAPS.vidhide;
  else if (url.includes("streamwish") || url.includes("hlswish") || url.includes("vibuxer")) matchedMap = QUALITY_MAPS.streamwish;

  if (matchedMap) {
    const match = url.match(/_,([a-z,]+),\.urlset/);
    if (match) {
      const qualities = match[1].split(",").filter(Boolean);
      for (const key of PRIORITY_KEYS) {
        if (qualities.includes(key) && matchedMap[key]) {
          return matchedMap[key];
        }
      }
    }
  }

  const resolutionMatch = url.match(/[_\-\/](\d{3,4})p/);
  return resolutionMatch ? `${resolutionMatch[1]}p` : "Unknown";
}

function getProviderName(url) {
  if (url.includes("goodstream")) return "GoodStream";
  if (url.includes("hlswish") || url.includes("streamwish")) return "StreamWish";
  if (url.includes("voe.sx") || url.includes("cloudwindow")) return "VOE";
  if (url.includes("filemoon")) return "Filemoon";
  if (url.includes("vimeos.net")) return "Vimeos";
  return "Online";
}

// ==========================================
// DECODIFICADORES DE SERVIDORES (RESOLVERS)
// ==========================================

async function resolveGoodStream(embedUrl) {
  try {
    const html = await request(embedUrl, {
      headers: { ...HEADERS_HTML, Referer: "https://goodstream.one" }
    });

    const fileMatch = html.match(/file:\s*"([^"]+)"/);
    if (!fileMatch) return null;

    const streamUrl = fileMatch[1];
    const quality = detectQualityFromUrl(streamUrl);

    return {
      url: streamUrl,
      quality,
      headers: { Referer: embedUrl, Origin: "https://goodstream.one", "User-Agent": USER_AGENT }
    };
  } catch (error) {
    return null;
  }
}

async function resolveVOE(embedUrl) {
  try {
    let html = await request(embedUrl, { headers: { ...HEADERS_HTML, Referer: embedUrl } });

    if (/permanentToken/i.test(html)) {
      const redirectMatch = html.match(/window\.location\.href\s*=\s*'([^']+)'/i);
      if (redirectMatch) {
        html = await request(redirectMatch[1], { headers: { ...HEADERS_HTML, Referer: embedUrl } });
      }
    }

    const streamMatch = html.match(/(?:mp4|hls)["']\s*:\s*["']([^"']+)["']/i);
    if (streamMatch) {
      let finalUrl = streamMatch[1];
      if (finalUrl.startsWith("aHR0")) {
        try { finalUrl = atob(finalUrl); } catch (e) {}
      }
      return {
        url: finalUrl,
        quality: detectQualityFromUrl(finalUrl),
        headers: { Referer: embedUrl }
      };
    }
    return null;
  } catch (error) {
    return null;
  }
}

async function resolveStreamWish(embedUrl) {
  try {
    let targetUrl = embedUrl.replace("hglink.to", "vibuxer.com");
    const domainMatch = targetUrl.match(/^(https?:\/\/[^/]+)/);
    const originDomain = domainMatch ? domainMatch[1] : "https://hlswish.com";

    const html = await request(targetUrl, {
      headers: { ...HEADERS_HTML, Referer: "https://embed69.org/", Origin: "https://embed69.org" }
    });

    const fileMatch = html.match(/file\s*:\s*["']([^"']+)["']/i);
    if (fileMatch) {
      let streamUrl = fileMatch[1];
      if (streamUrl.startsWith("/")) streamUrl = originDomain + streamUrl;

      return {
        url: streamUrl,
        quality: detectQualityFromUrl(streamUrl),
        headers: { "User-Agent": USER_AGENT, Referer: originDomain + "/" }
      };
    }
    return null;
  } catch (error) {
    return null;
  }
}

function getResolver(url) {
  if (url.includes("goodstream.one")) return resolveGoodStream;
  if (url.includes("voe.sx") || url.includes("voe")) return resolveVOE;
  if (url.includes("hlswish") || url.includes("streamwish") || url.includes("vibuxer")) return resolveStreamWish;
  return null;
}

// ==========================================
// CONSULTA A TMDB Y LA MOVIE API
// ==========================================

async function getTMDBDetails(tmdbId, type) {
  const languages = ["es-MX", "en-US"];

  const requests = languages.map((lang) =>
    request(`https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&language=${lang}`).catch(() => null)
  );

  const [latinData, englishData] = await Promise.all(requests);
  const data = latinData || englishData;

  if (!data) return null;

  return {
    title: type === "movie" ? data.title : data.name,
    originalTitle: type === "movie" ? data.original_title : data.original_name,
    year: (data.release_date || data.first_air_date || "").substring(0, 4),
    genres: (data.genres || []).map((g) => g.id),
    originCountries: data.origin_country || (data.production_countries || []).map((c) => c.iso_3166_1)
  };
}

async function findPostIdBySlug(details, type) {
  const categories = type === "movie" 
    ? ["peliculas"] 
    : (details.genres.includes(ANIME_GENRE_ID) && details.originCountries.some(c => ASIAN_COUNTRIES.includes(c))) 
      ? ["animes", "series"] 
      : ["series"];

  const slugsToTry = [];
  if (details.title) slugsToTry.push(normalizeSlug(details.title, details.year));
  if (details.originalTitle && details.originalTitle !== details.title) {
    slugsToTry.push(normalizeSlug(details.originalTitle, details.year));
  }

  for (const category of categories) {
    for (const slug of slugsToTry) {
      try {
        const pageUrl = `${BASE_URL}/${category}/${slug}/`;
        const html = await request(pageUrl, { headers: HEADERS_HTML });
        const shortlinkMatch = html.match(/rel=['"]shortlink['"]\s+href=['"][^'"]*\?p=(\d+)['"]/);

        if (shortlinkMatch) {
          return shortlinkMatch[1];
        }
      } catch (e) {
        // Continúa buscando en los siguientes slugs
      }
    }
  }
  return null;
}

async function getEpisodePostId(seriesPostId, season, episode) {
  const apiUrl = `${BASE_URL}/wp-api/v1/single/episodes/list?_id=${seriesPostId}&season=${season}&page=1&postsPerPage=50`;
  try {
    const response = await request(apiUrl);
    if (response?.data?.posts) {
      const match = response.data.posts.find((ep) => ep.season_number == season && ep.episode_number == episode);
      return match?._id || null;
    }
  } catch (error) {
    return null;
  }
  return null;
}

async function processEmbed(embed) {
  const resolver = getResolver(embed.url);
  if (!resolver) return null;

  const resolved = await resolver(embed.url);
  if (!resolved || !resolved.url) return null;

  const serverName = getProviderName(embed.url);
  const quality = resolved.quality || "720p";

  return {
    name: "LaMovie",
    title: `${quality} · ${serverName}`,
    url: resolved.url,
    quality: quality,
    headers: resolved.headers || {}
  };
}

// ==========================================
// FUNCIÓN PRINCIPAL EXPORTADA
// ==========================================

/**
 * Obtiene las fuentes de reproducción para Nuvio
 * @param {string} tmdbId - ID de TMDB (ej: "550")
 * @param {string} type - "movie" o "tv"
 * @param {number} [season] - Número de temporada (para series)
 * @param {number} [episode] - Número de episodio (para series)
 */
async function getStreams(tmdbId, type, season, episode) {
  if (!tmdbId || !type) return [];

  console.log(`[LaMovie] Buscando ID TMDB: ${tmdbId} (${type})${season ? ` S${season}E${episode}` : ""}`);

  try {
    const tmdbDetails = await getTMDBDetails(tmdbId, type);
    if (!tmdbDetails) {
      console.log("[LaMovie] No se pudieron obtener datos desde TMDB");
      return [];
    }

    let postId = await findPostIdBySlug(tmdbDetails, type);
    if (!postId) {
      console.log("[LaMovie] No se encontró la publicación por URL/Slug");
      return [];
    }

    if (type === "tv" && season && episode) {
      postId = await getEpisodePostId(postId, season, episode);
      if (!postId) {
        console.log(`[LaMovie] Episodio S${season}E${episode} no encontrado`);
        return [];
      }
    }

    const playerData = await request(`${BASE_URL}/wp-api/v1/player?postId=${postId}&demo=0`);
    if (!playerData?.data?.embeds) {
      console.log("[LaMovie] La publicación no contiene reproducciones disponibles");
      return [];
    }

    const streamPromises = playerData.data.embeds.map((embed) => processEmbed(embed));
    const results = await Promise.allSettled(streamPromises);

    const activeStreams = results
      .filter((res) => res.status === "fulfilled" && res.value !== null)
      .map((res) => res.value);

    console.log(`[LaMovie] Éxito: ${activeStreams.length} enlace(s) generado(s)`);
    return activeStreams;

  } catch (error) {
    console.error(`[LaMovie] Error crítico: ${error.message}`);
    return [];
  }
}

module.exports = {
  getStreams
};
