/* eslint-disable @typescript-eslint/no-unused-vars */
import { getPixel, strokeLine } from '@tubular/util';
import { abs, atan, atan2, ceil, cos, cos_deg, floor, max, min, mod, PI, round, sin, sin_deg, SphericalPosition3D, sqrt, to_radian } from '@tubular/math';

const MAP_HEIGHT = 500;
const MAP_WIDTH = 1000;
const AA_SCALE = 3;
const GLOBE_SIZE = 500;
const VIEW_DISTANCE = 100; // Earth radii
const VIEW_ANGLE = atan(sqrt(VIEW_DISTANCE ** 2 + 2 * VIEW_DISTANCE));
const VIEW_RADIUS = sin(VIEW_ANGLE);
const VIEW_PLANE = cos(VIEW_ANGLE);

export class Globe {
  private static mapFailed = false;
  private static mapImage: HTMLImageElement;
  private static mapLoading = false;
  private static mapPixels: ImageData;
  private static waitList: { resolve: () => void, reject: (reason: any) => void }[] = [];

  private canvas = document.createElement('canvas');
  private lat: number;
  private lon: number;

  static loadMap(): void {
    this.mapLoading = true;

    const imagePromise = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();

      image.onload = (): void => {
        resolve(image);
      };
      image.onerror = (): void => {
        reject(new Error('Map image failed to load from: ' + image.src));
      };

      image.src = 'assets/world.jpg';
    });

    imagePromise.then(image => {
      this.mapLoading = false;
      this.mapImage = image;

      const canvas = document.createElement('canvas');

      canvas.width = MAP_WIDTH;
      canvas.height = MAP_HEIGHT;

      const context = canvas.getContext('2d');

      context.drawImage(image, 0, 0, MAP_WIDTH, MAP_HEIGHT);
      context.strokeStyle = '#6A6A6A';

      // Draw lines of latitude
      for (let lat = -75; lat < 90; lat += 15) {
        const y = (lat + 90) / 180 * MAP_HEIGHT;

        strokeLine(context, 0, y, MAP_WIDTH, y);
      }

      // Draw lines of longitude
      for (let lon = 0; lon < 360; lon += 15) {
        const x = lon / 360 * MAP_WIDTH;

        strokeLine(context, x, 0, x, MAP_HEIGHT);
      }

      const canvas2 = document.createElement('canvas');

      canvas2.width = MAP_WIDTH * AA_SCALE;
      canvas2.height = MAP_HEIGHT * AA_SCALE;

      const context2 = canvas2.getContext('2d');

      context2.drawImage(canvas, 0, 0, MAP_WIDTH * AA_SCALE, MAP_HEIGHT * AA_SCALE);

      this.mapPixels = context2.getImageData(0, 0, MAP_WIDTH * AA_SCALE, MAP_HEIGHT * AA_SCALE);
      this.waitList.forEach(cb => cb.resolve());
    }, reason => {
      this.mapLoading = false;
      this.mapFailed = true;
      this.waitList.forEach(cb => cb.reject(reason instanceof Error ? reason : new Error(reason)));
      console.error(reason);
    });
  }

  constructor() {
    this.canvas.width = this.canvas.height = GLOBE_SIZE;

    if (!Globe.mapImage && !Globe.mapFailed && !Globe.mapLoading)
      Globe.loadMap();
  }

  async draw(lat: number, lon: number): Promise<void> {
    if (Globe.mapFailed)
      throw new Error('Map not available');
    else if (!Globe.mapImage)
      await new Promise<void>((resolve, reject) => Globe.waitList.push({ resolve, reject }));

    if (this.lat !== lat || this.lon !== lon)
      this.generateRotatedGlobe(lat, lon);
  }

  private generateRotatedGlobe(lon: number, lat: number): void {
    const context = this.canvas.getContext('2d');

    this.lat = lat;
    this.lon = lon;
    context.clearRect(0, 0, GLOBE_SIZE, GLOBE_SIZE);

    const rt = GLOBE_SIZE / 2;
    const eye = new SphericalPosition3D(0, 0, VIEW_DISTANCE + 1).xyz;
    const yaw = to_radian(this.lon);
    const pitch = to_radian(-this.lat);
    const roll = Math.PI;

    const cose = Math.cos(yaw);
    const sina = Math.sin(yaw);
    const cosb = Math.cos(pitch);
    const sinb = Math.sin(pitch);
    const cosc = Math.cos(roll);
    const sinc = Math.sin(roll);

    const Axx = cose * cosb;
    const Axy = cose * sinb * sinc - sina * cosc;
    const Axz = cose * sinb * cosc + sina * sinc;
    const Ayx = sina * cosb;
    const Ayy = sina * sinb * sinc + cose * cosc;
    const Ayz = sina * sinb * cosc - cose * sinc;
    const Azx = -sinb;
    const Azy = cosb * sinc;
    const Azz = cosb * cosc;

    for (let yt = 0; yt < GLOBE_SIZE; ++yt) {
      for (let xt = 0; xt < GLOBE_SIZE; ++xt) {
        const d = sqrt((xt - rt) ** 2 + (yt - rt) ** 2);
        let alpha = 1;

        if (d > rt + 0.5)
          continue;
        else if (d > rt - 0.5)
          alpha = rt - d + 0.5;

        const x0 = VIEW_PLANE;
        const y0 = (xt - rt) / GLOBE_SIZE * VIEW_RADIUS * 2;
        const z0 = (rt - yt) / GLOBE_SIZE * VIEW_RADIUS * 2;
        const dx = eye.x - x0;
        const dy = eye.y - y0;
        const dz = eye.z - z0;
        // Unit vector for line-of-sight
        const mag = sqrt(dx ** 2 + dy ** 2 + dz ** 2);
        const xu = dx / mag;
        const yu = dy / mag;
        const zu = dz / mag;
        // Dot product of unit vector and origin
        const dp = xu * eye.x + yu * eye.y + zu * eye.z;
        const nabla = max(dp ** 2 - (VIEW_DISTANCE + 1) ** 2 + 1, 0);
        // Distance from eye to globe intersection
        const di = -dp + sqrt(nabla);
        // Point of intersection with surface of globe
        const xi = eye.x + di * xu;
        const yi = eye.y + di * yu;
        const zi = eye.z + di * zu;
        // Rotate to match lat/long
        const x1 = Axx * xi + Axy * yi + Axz * zi;
        const y1 = Ayx * xi + Ayy * yi + Ayz * zi;
        const z1 = Azx * xi + Azy * yi + Azz * zi;
        const i = SphericalPosition3D.convertRectangular(x1, y1, z1);
        const xs = mod(i.longitude.degrees + 180, 360) / 360 * MAP_WIDTH * AA_SCALE;
        const ys = (90 - i.latitude.degrees) / 180 * MAP_HEIGHT * AA_SCALE;
        const pixel = getPixel(Globe.mapPixels, round(xs), round(ys)) & 0xFF;

        context.fillStyle = `rgba(${pixel}, ${pixel}, ${pixel}, ${alpha})`;
        context.fillRect(xt, yt, 1, 1);
      }
    }

    document.getElementById('temp-image').appendChild(this.canvas);
  }
}
