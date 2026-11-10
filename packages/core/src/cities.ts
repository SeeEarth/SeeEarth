// Seed points for "work anywhere" mode: [name, lon, lat, weight (≈ metro population, millions)].
// Agents are sent near one of these (weighted) and the server spirals outward to the nearest
// unfinished tile, so the map fills in where people will actually look first.
export const SEED_CITIES: [string, number, number, number][] = [
  ["Tokyo", 139.767, 35.681, 37], ["Delhi", 77.209, 28.614, 32], ["Shanghai", 121.474, 31.230, 28], ["Dhaka", 90.413, 23.811, 23],
  ["São Paulo", -46.633, -23.551, 22], ["Mexico City", -99.133, 19.433, 22], ["Cairo", 31.236, 30.044, 22], ["Beijing", 116.407, 39.904, 21],
  ["Mumbai", 72.878, 19.076, 21], ["Osaka", 135.502, 34.694, 19], ["Karachi", 67.010, 24.861, 17], ["Chongqing", 106.551, 29.563, 17],
  ["Istanbul", 28.978, 41.008, 16], ["Buenos Aires", -58.382, -34.604, 15], ["Kolkata", 88.364, 22.573, 15], ["Lagos", 3.379, 6.524, 15],
  ["Kinshasa", 15.266, -4.442, 15], ["Manila", 120.984, 14.600, 14], ["Lahore", 74.344, 31.549, 14], ["Rio de Janeiro", -43.173, -22.907, 13],
  ["Guangzhou", 113.264, 23.129, 13], ["Bangalore", 77.595, 12.972, 13], ["Moscow", 37.618, 55.756, 12], ["Shenzhen", 114.058, 22.543, 12],
  ["Chennai", 80.271, 13.083, 11], ["Jakarta", 106.845, -6.208, 11], ["Bogotá", -74.072, 4.711, 11], ["Paris", 2.352, 48.857, 11],
  ["Lima", -77.043, -12.046, 11], ["Bangkok", 100.502, 13.756, 11], ["Hyderabad", 78.487, 17.385, 10], ["Seoul", 126.978, 37.567, 10],
  ["London", -0.128, 51.507, 9.5], ["Tehran", 51.389, 35.689, 9.5], ["Chicago", -87.630, 41.878, 8.9], ["New York", -73.986, 40.758, 19],
  ["Ho Chi Minh City", 106.700, 10.776, 9], ["Luanda", 13.234, -8.839, 9], ["Ahmedabad", 72.571, 23.023, 8.5], ["Kuala Lumpur", 101.687, 3.139, 8.4],
  ["Hong Kong", 114.169, 22.319, 7.5], ["Riyadh", 46.675, 24.713, 7.5], ["Baghdad", 44.366, 33.315, 7.5], ["Santiago", -70.669, -33.449, 6.9],
  ["Madrid", -3.704, 40.417, 6.7], ["Pune", 73.857, 18.520, 6.8], ["Dar es Salaam", 39.208, -6.792, 7.4], ["Toronto", -79.383, 43.653, 6.4],
  ["Belo Horizonte", -43.938, -19.920, 6.2], ["Khartoum", 32.560, 15.501, 6.2], ["Singapore", 103.820, 1.352, 5.9], ["Philadelphia", -75.165, 39.953, 5.8],
  ["Barcelona", 2.173, 41.385, 5.7], ["Saint Petersburg", 30.336, 59.934, 5.5], ["Abidjan", -4.008, 5.360, 5.5], ["Yangon", 96.196, 16.866, 5.5],
  ["Alexandria", 29.919, 31.200, 5.5], ["Ankara", 32.854, 39.920, 5.3], ["Faisalabad", 73.084, 31.450, 3.7], ["Rawalpindi", 73.047, 33.598, 2.3],
  ["Islamabad", 73.048, 33.684, 1.2], ["Peshawar", 71.578, 34.015, 2.3], ["Multan", 71.475, 30.157, 2.2], ["Quetta", 66.990, 30.180, 1.2],
  ["Dubai", 55.271, 25.205, 3.6], ["Abu Dhabi", 54.377, 24.454, 1.5], ["Doha", 51.531, 25.286, 2.4], ["Jeddah", 39.173, 21.543, 4.7],
  ["Mecca", 39.826, 21.389, 2.4], ["Kabul", 69.207, 34.555, 4.5], ["Johannesburg", 28.047, -26.204, 6.1], ["Cape Town", 18.424, -33.925, 4.8],
  ["Nairobi", 36.822, -1.292, 5.1], ["Addis Ababa", 38.757, 9.030, 5.4], ["Casablanca", -7.590, 33.573, 3.8], ["Accra", -0.187, 5.604, 2.6],
  ["Sydney", 151.209, -33.869, 5.3], ["Melbourne", 144.963, -37.814, 5.1], ["Auckland", 174.763, -36.848, 1.7], ["Los Angeles", -118.244, 34.052, 12.5],
  ["San Francisco", -122.419, 37.775, 3.3], ["Seattle", -122.332, 47.606, 3.4], ["Miami", -80.192, 25.762, 6.1], ["Houston", -95.370, 29.760, 7],
  ["Dallas", -96.797, 32.777, 7.5], ["Atlanta", -84.388, 33.749, 6], ["Boston", -71.059, 42.360, 4.9], ["Washington", -77.037, 38.907, 6.3],
  ["Montreal", -73.568, 45.502, 4.3], ["Vancouver", -123.121, 49.283, 2.6], ["Havana", -82.366, 23.113, 2.1], ["Caracas", -66.904, 10.481, 2.9],
  ["Berlin", 13.405, 52.520, 3.7], ["Rome", 12.496, 41.903, 4.3], ["Milan", 9.190, 45.464, 3.1], ["Athens", 23.728, 37.984, 3.2],
  ["Vienna", 16.373, 48.208, 2], ["Amsterdam", 4.904, 52.368, 1.2], ["Brussels", 4.352, 50.847, 2.1], ["Lisbon", -9.139, 38.722, 2.9],
  ["Warsaw", 21.012, 52.230, 1.8], ["Prague", 14.438, 50.075, 1.3], ["Stockholm", 18.069, 59.329, 1.6], ["Copenhagen", 12.568, 55.676, 1.4],
  ["Dublin", -6.260, 53.350, 1.4], ["Manchester", -2.244, 53.483, 2.8], ["Edinburgh", -3.188, 55.953, 0.5], ["Oxford", -1.258, 51.752, 0.2],
  ["Kyiv", 30.523, 50.450, 3], ["Tashkent", 69.240, 41.300, 2.9], ["Almaty", 76.886, 43.238, 2], ["Colombo", 79.861, 6.927, 2.3],
  ["Kathmandu", 85.324, 27.717, 1.5], ["Hanoi", 105.834, 21.028, 8], ["Taipei", 121.565, 25.033, 7], ["Busan", 129.075, 35.180, 3.4],
  ["Kyoto", 135.768, 35.012, 1.5], ["Chengdu", 104.066, 30.573, 16], ["Wuhan", 114.305, 30.593, 11], ["Xi'an", 108.940, 34.341, 9],
  ["Surabaya", 112.752, -7.250, 3], ["Phnom Penh", 104.928, 11.556, 2.3], ["Medellín", -75.564, 6.244, 4],
  ["Quito", -78.467, -0.180, 2.8], ["Montevideo", -56.164, -34.901, 1.8], ["Brasília", -47.882, -15.794, 4.7], ["Guadalajara", -103.349, 20.659, 5.3],
  ["Tunis", 10.182, 36.806, 2.4], ["Algiers", 3.059, 36.754, 2.9], ["Amman", 35.930, 31.950, 4.2], ["Beirut", 35.502, 33.894, 2.4],
  ["Jerusalem", 35.217, 31.769, 1.3], ["Tel Aviv", 34.781, 32.085, 4.2], ["Baku", 49.867, 40.409, 2.3], ["Tbilisi", 44.827, 41.716, 1.2],
];

export function pickSeedCity(rand = Math.random): [string, number, number] {
  const total = SEED_CITIES.reduce((s, c) => s + c[3], 0);
  let r = rand() * total;
  for (const c of SEED_CITIES) { r -= c[3]; if (r <= 0) return [c[0], c[1], c[2]]; }
  const c = SEED_CITIES[0]; return [c[0], c[1], c[2]];
}
