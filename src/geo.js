export function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function hasCoords(x) {
  return x && Number.isFinite(x.lat) && Number.isFinite(x.lng);
}

export function mapsLink({ lat, lng }) {
  return `https://maps.google.com/?q=${lat.toFixed(5)},${lng.toFixed(5)}`;
}

export function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

// Free OpenStreetMap geocoder. Policy: identify yourself, max 1 request per second.
export async function geocode(query) {
  if (!query || query.length < 3) return null;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ReliefLine/1.0 (hackathon disaster-response demo)', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const [hit] = await res.json();
    if (!hit) return null;
    return { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name };
  } catch {
    return null;
  }
}
