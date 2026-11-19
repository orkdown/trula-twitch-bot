import { config } from "./config.js";

const VK_MUSIC_PATTERNS = [
  /https?:\/\/(?:m\.)?vk\.(?:com|ru)\/(?:audio|music\/track\/)[-_a-zA-Z0-9]+/i,
  /https?:\/\/(?:m\.)?vk\.(?:com|ru)\/[^?#]+\?z=audio[-_0-9]+/i,
];

const VK_VIDEO_PATTERNS = [
  /https?:\/\/(?:m\.)?vk\.(?:com|ru)\/(?:video|clip)[-_a-zA-Z0-9]+/i,
  /https?:\/\/vkvideo\.ru\/video[-_a-zA-Z0-9]+/i,
];

const MUSIC_PATTERNS = [
  /https?:\/\/(?:open\.)?spotify\.com\/track\/[a-zA-Z0-9]+/i,
  /https?:\/\/spotify\.link\/[a-zA-Z0-9]+/i,
  /https?:\/\/music\.yandex\.(?:ru|com|kz|by)\/(?:album\/\d+\/)?track\/\d+/i,
  /https?:\/\/music\.apple\.com\/[a-zA-Z0-9_\-\/]+/i,
  /https?:\/\/(?:www\.)?deezer\.com\/[a-zA-Z0-9_\-\/]+/i,
  /https?:\/\/soundcloud\.com\/[a-zA-Z0-9_\-\/]+/i,
  ...VK_MUSIC_PATTERNS,
  ...VK_VIDEO_PATTERNS,
];

export function isVkMusicUrl(text) {
  if (!text) return false;
  return VK_MUSIC_PATTERNS.some((p) => p.test(text));
}

export function isVkVideoUrl(text) {
  if (!text) return false;
  return VK_VIDEO_PATTERNS.some((p) => p.test(text));
}

export function extractMusicUrl(text) {
  if (!text) return null;
  for (const pattern of MUSIC_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

// Direct zero-dependency YouTube search
export async function directYoutubeSearch(query) {
  if (!query || !query.trim()) return null;
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query.trim())}`;
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        Cookie: "CONSENT=YES+cb.20210328-17-p0.en+FX+478",
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/ytInitialData\s*=\s*({.+?});<\/script>/s);
    if (!match) return null;

    const data = JSON.parse(match[1]);
    const contents =
      data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
    const itemSection = contents?.find((c) => c.itemSectionRenderer)?.itemSectionRenderer?.contents;
    const video = itemSection?.find((i) => i.videoRenderer)?.videoRenderer;
    if (video && video.videoId) {
      return {
        url: `https://youtube.com/watch?v=${video.videoId}`,
        title: video.title?.runs?.[0]?.text || query,
        thumbnail:
          video.thumbnail?.thumbnails?.slice(-1)[0]?.url ||
          `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
      };
    }
  } catch (e) {
    console.warn("[Converter] Direct YouTube search error:", e.message);
  }
  return null;
}

// Direct local metadata resolvers (independent of external VPS)
async function resolveDirectMetadata(url) {
  // 1. Yandex Music API
  if (url.includes("music.yandex.")) {
    const trackMatch = url.match(/track\/(\d+)/);
    if (trackMatch) {
      try {
        const res = await fetch(`https://api.music.yandex.net/tracks/${trackMatch[1]}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json();
          const tr = data.result?.[0];
          if (tr) {
            return {
              title: tr.title,
              artist: tr.artists?.map((a) => a.name).join(", ") || "",
              image: tr.coverUri ? `https://${tr.coverUri.replace("%%", "400x400")}` : "",
            };
          }
        }
      } catch {}
    }
  }

  // 2. Apple Music / iTunes API
  if (url.includes("music.apple.com")) {
    const trackIdMatch =
      url.match(/[?&]i=(\d+)/) ||
      url.match(/\/album\/[^\/]+\/(\d+)/) ||
      url.match(/\/id(\d+)/);
    if (trackIdMatch) {
      try {
        const res = await fetch(`https://itunes.apple.com/lookup?id=${trackIdMatch[1]}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json();
          const item = data.results?.[0];
          if (item) {
            return {
              title: item.trackName || item.collectionName || "",
              artist: item.artistName || "",
              image: item.artworkUrl100?.replace("100x100bb", "600x600bb") || "",
            };
          }
        }
      } catch {}
    }
  }

  // 3. Deezer API
  if (url.includes("deezer.com")) {
    const trackMatch = url.match(/track\/(\d+)/);
    if (trackMatch) {
      try {
        const res = await fetch(`https://api.deezer.com/track/${trackMatch[1]}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.title) {
            return {
              title: data.title,
              artist: data.artist?.name || "",
              image: data.album?.cover_medium || "",
            };
          }
        }
      } catch {}
    }
  }

  // 4. Spotify oEmbed
  if (url.includes("spotify.com")) {
    try {
      const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.title) {
          return {
            title: data.title,
            artist: "",
            image: data.thumbnail_url || "",
          };
        }
      }
    } catch {}
  }

  // 5. SoundCloud oEmbed
  if (url.includes("soundcloud.com")) {
    try {
      const res = await fetch(
        `https://soundcloud.com/oembed?url=${encodeURIComponent(url)}&format=json`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (res.ok) {
        const data = await res.json();
        return {
          title: data.title || "",
          artist: data.author_name || "",
          image: data.thumbnail_url || "",
        };
      }
    } catch {}
  }

  return null;
}

export async function convertMusicUrl(input) {
  if (!input) return null;
  const trimmed = input.trim();

  // 1. YouTube direct link (already valid)
  if (trimmed.includes("youtube.com") || trimmed.includes("youtu.be")) {
    return {
      title: "YouTube Video",
      artist: "",
      youtubeUrl: trimmed,
      thumbnailUrl: "",
    };
  }

  // 2. VKontakte check
  if (isVkMusicUrl(trimmed)) {
    // Trula does NOT support VK Music natively, and VK locks audio for unauthenticated guests
    return {
      isVkMusic: true,
      error: "vk_music_not_supported",
      message:
        "Trula и ВКонтакте не поддерживают ссылки на VK Музыку. Чтобы заказать трек, напишите его текстом: «!link Исполнитель - Трек» или используйте ссылку из Яндекс Музыки / Spotify!",
    };
  }

  if (isVkVideoUrl(trimmed)) {
    // VK Video can be played directly by Trula or converted
    return {
      isVkVideo: true,
      url: trimmed,
      message:
        "Это ссылка на VK Видео. Trula поддерживает VK Видео напрямую — вставьте эту ссылку в награду за баллы!",
    };
  }

  // 3. Plain text query (e.g. "!link Queen Bohemian Rhapsody" or "!link Кино - Группа крови")
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    console.log(`[Converter] Поиск трека по текстовому запросу: "${trimmed}"`);
    const yt = await directYoutubeSearch(trimmed);
    if (yt) {
      return {
        title: yt.title,
        artist: "",
        youtubeUrl: yt.url,
        thumbnailUrl: yt.thumbnail,
      };
    }
    return null;
  }

  // 4. Try primary remote converter API (Music2YouTube VPS endpoint)
  try {
    const apiUrl = `${config.converterApiUrl}?url=${encodeURIComponent(trimmed)}`;
    const res = await fetch(apiUrl, {
      headers: { "User-Agent": "TrulaTwitchBot/1.0" },
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const data = await res.json();
      const ytUrl = data.linksByPlatform?.youtube?.url;
      if (ytUrl) {
        const entity = data.entitiesByUniqueId?.[data.entityUniqueId] || {};
        return {
          title: entity.title || "Трек",
          artist: entity.artistName || "",
          youtubeUrl: ytUrl,
          thumbnailUrl: entity.thumbnailUrl || "",
        };
      }
    }
  } catch (err) {
    console.warn("[Converter] Удаленный конвертер недоступен, пробуем встроенные резолверы:", err.message);
  }

  // 5. Local failsafe resolver (direct unauthenticated APIs + direct YouTube search)
  try {
    const meta = await resolveDirectMetadata(trimmed);
    if (meta && meta.title) {
      const query = meta.artist ? `${meta.artist} - ${meta.title}` : meta.title;
      const yt = await directYoutubeSearch(query);
      if (yt) {
        return {
          title: meta.title,
          artist: meta.artist,
          youtubeUrl: yt.url,
          thumbnailUrl: meta.image || yt.thumbnail,
        };
      }
    }
  } catch (e) {
    console.warn("[Converter] Встроенный резолвер ошибка:", e.message);
  }

  return null;
}
