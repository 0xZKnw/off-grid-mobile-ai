import { Platform, NativeModules } from 'react-native';
import DeviceInfo from 'react-native-device-info';

// Access NativeModules.LocalDreamModule dynamically (not destructured)
// so it can be mocked in tests after module import.
const getLocalDreamModule = () => NativeModules.LocalDreamModule;
import { DeviceInfo as DeviceInfoType, ModelRecommendation, SoCInfo, SoCVendor, ImageModelRecommendation } from '../types';
import { MODEL_RECOMMENDATIONS, RECOMMENDED_MODELS } from '../constants';

/**
 * QNN variant tiers — mirrors local-dream's chipsetModelSuffixes map exactly.
 * Source: https://github.com/xororz/local-dream — Model.kt getChipsetSuffix()
 *
 * - 8gen2: SM8550, SM8650, SM8735, SM8750, SM8845, SM8850
 * - 8gen1: SM8450, SM8475
 * - min:   any other SM-prefixed chip (fallback, same as local-dream)
 */
const FLAGSHIP_8GEN2 = new Set([8550, 8650, 8735, 8750, 8845, 8850]);
const FLAGSHIP_8GEN1 = new Set([8450, 8475]);

// Exynos SoC prefixes (Build.SOC_MODEL): S5E9945=Exynos2400, S5E9925=Exynos2200, S5E9840=Exynos2100
const EXYNOS_SOC_VARIANTS: Array<{ prefix: string; variant: 'exynos2400' | 'exynos2200' | 'exynos2100' }> = [
  { prefix: 'S5E9945', variant: 'exynos2400' },
  { prefix: 'S5E9925', variant: 'exynos2200' },
  { prefix: 'S5E9840', variant: 'exynos2100' },
];

class HardwareService {
  private cachedDeviceInfo: DeviceInfoType | null = null;
  private cachedSoCInfo: SoCInfo | null = null;
  private cachedImageRecommendation: ImageModelRecommendation | null = null;

  async getDeviceInfo(): Promise<DeviceInfoType> {
    if (this.cachedDeviceInfo) {
      return this.cachedDeviceInfo;
    }

    const [
      totalMemory,
      usedMemory,
      deviceModel,
      systemName,
      systemVersion,
      isEmulator,
    ] = await Promise.all([
      DeviceInfo.getTotalMemory(),
      DeviceInfo.getUsedMemory(),
      DeviceInfo.getModel(),
      DeviceInfo.getSystemName(),
      DeviceInfo.getSystemVersion(),
      DeviceInfo.isEmulator(),
    ]);

    this.cachedDeviceInfo = {
      totalMemory,
      usedMemory,
      availableMemory: totalMemory - usedMemory,
      deviceModel,
      systemName,
      systemVersion,
      isEmulator,
    };

    return this.cachedDeviceInfo;
  }

  async refreshMemoryInfo(): Promise<DeviceInfoType> {
    // Force fresh fetch of all memory info
    const [totalMemory, usedMemory] = await Promise.all([
      DeviceInfo.getTotalMemory(),
      DeviceInfo.getUsedMemory(),
    ]);

    if (!this.cachedDeviceInfo) {
      await this.getDeviceInfo();
    }

    if (this.cachedDeviceInfo) {
      this.cachedDeviceInfo.totalMemory = totalMemory;
      this.cachedDeviceInfo.usedMemory = usedMemory;
      this.cachedDeviceInfo.availableMemory = totalMemory - usedMemory;
    }

    return this.cachedDeviceInfo!;
  }

  /** Get app-specific memory usage (system memory; native allocations may not be fully reflected). */
  async getAppMemoryUsage(): Promise<{ used: number; available: number; total: number }> {
    const total = await DeviceInfo.getTotalMemory();
    const used = await DeviceInfo.getUsedMemory();
    return { used, available: total - used, total };
  }

  getTotalMemoryGB(): number {
    if (!this.cachedDeviceInfo) {
      return 4; // Default assumption
    }
    return this.cachedDeviceInfo.totalMemory / (1024 * 1024 * 1024);
  }

  getAvailableMemoryGB(): number {
    if (!this.cachedDeviceInfo) {
      return 2; // Default assumption
    }
    return this.cachedDeviceInfo.availableMemory / (1024 * 1024 * 1024);
  }

  getModelRecommendation(): ModelRecommendation {
    const totalRamGB = this.getTotalMemoryGB();

    // Find the appropriate recommendation tier
    const tier = MODEL_RECOMMENDATIONS.memoryToParams.find(
      t => totalRamGB >= t.minRam && totalRamGB < t.maxRam
    ) || MODEL_RECOMMENDATIONS.memoryToParams[0];

    // Filter recommended models based on device capability
    const compatibleModels = RECOMMENDED_MODELS
      .filter(m => m.minRam <= totalRamGB)
      .map(m => m.id);

    let warning: string | undefined;
    if (totalRamGB < 4) {
      warning = 'Your device has limited memory. Only the smallest models will work well.';
    } else if (this.cachedDeviceInfo?.isEmulator) {
      warning = 'Running in emulator. Performance may be significantly slower.';
    }

    return {
      maxParameters: tier.maxParams,
      recommendedQuantization: tier.quantization,
      recommendedModels: compatibleModels,
      warning,
    };
  }

  canRunModel(parametersBillions: number, quantization: string = 'Q4_K_M'): boolean {
    const availableMemoryGB = this.getAvailableMemoryGB();
    // Q4_K_M uses ~0.5 bytes per parameter + overhead; need at least 1.5x model size
    const bitsPerWeight = this.getQuantizationBits(quantization);
    const modelSizeGB = (parametersBillions * bitsPerWeight) / 8;
    const requiredMemory = modelSizeGB * 1.5;
    return availableMemoryGB >= requiredMemory;
  }

  estimateModelMemoryGB(parametersBillions: number, quantization: string = 'Q4_K_M'): number {
    const bitsPerWeight = this.getQuantizationBits(quantization);
    return (parametersBillions * bitsPerWeight) / 8;
  }

  private getQuantizationBits(quantization: string): number {
    const bits: Record<string, number> = {
      'Q2_K': 2.625,
      'Q3_K_S': 3.4375,
      'Q3_K_M': 3.4375,
      'Q4_0': 4,
      'Q4_K_S': 4.5,
      'Q4_K_M': 4.5,
      'Q5_K_S': 5.5,
      'Q5_K_M': 5.5,
      'Q6_K': 6.5,
      'Q8_0': 8,
      'F16': 16,
    };
    // Try to match quantization string
    for (const [key, value] of Object.entries(bits)) {
      if (quantization.toUpperCase().includes(key)) {
        return value;
      }
    }
    return 4.5; // Default to Q4_K_M
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
  }

  /** Returns total size of model including mmproj companion file. Use everywhere size is displayed. */
  getModelTotalSize(model: { fileSize?: number; size?: number; mmProjFileSize?: number }): number {
    const mainSize = model.fileSize || model.size || 0;
    const mmProjSize = model.mmProjFileSize || 0;
    return mainSize + mmProjSize;
  }

  /** Formats total model size including mmproj. Use everywhere size is displayed. */
  formatModelSize(model: { fileSize?: number; size?: number; mmProjFileSize?: number }): string {
    return this.formatBytes(this.getModelTotalSize(model));
  }

  /** Returns estimated RAM usage for a model (total size * overhead multiplier). */
  estimateModelRam(model: { fileSize?: number; size?: number; mmProjFileSize?: number }, multiplier: number = 1.5): number {
    return this.getModelTotalSize(model) * multiplier;
  }

  /** Formats estimated RAM usage for a model. */
  formatModelRam(model: { fileSize?: number; size?: number; mmProjFileSize?: number }, multiplier: number = 1.5): string {
    const ramBytes = this.estimateModelRam(model, multiplier);
    const ramGB = ramBytes / (1024 * 1024 * 1024);
    return `~${ramGB.toFixed(1)} GB`;
  }

  private detectAppleChip(deviceId: string): SoCInfo['appleChip'] {
    const match = deviceId.match(/iPhone(\d+)/);
    if (!match) return undefined;
    const major = parseInt(match[1], 10);
    if (major >= 17) return 'A18';
    if (major >= 16) return 'A17Pro';
    if (major >= 15) return 'A16';
    if (major >= 14) return 'A15';
    if (major >= 13) return 'A14';
    return undefined;
  }

  private detectAndroidVendor(hw: string, model: string, socModel: string = ''): SoCVendor {
    const normalizedModel = model.toLowerCase();
    const upperSocModel = socModel.toUpperCase();

    if (hw.includes('qcom') || upperSocModel.startsWith('SM')) return 'qualcomm';
    if (normalizedModel.startsWith('pixel') || upperSocModel.includes('TENSOR')) return 'tensor';
    if (hw.includes('mt') || hw.includes('mediatek')) return 'mediatek';
    if (
      hw.includes('exynos') ||
      hw.includes('samsungexynos') ||
      hw.startsWith('s5e') ||
      upperSocModel.startsWith('S5E')
    ) {
      return 'exynos';
    }
    return 'unknown';
  }

  async getSoCInfo(): Promise<SoCInfo> {
    if (this.cachedSoCInfo) return this.cachedSoCInfo;
    if (Platform.OS === 'ios') {
      const ramGB = this.getTotalMemoryGB();
      const appleChip = this.detectAppleChip(DeviceInfo.getDeviceId()) ?? (ramGB >= 6 ? 'A15' : 'A14');
      this.cachedSoCInfo = { vendor: 'apple', hasNPU: true, appleChip };
      return this.cachedSoCInfo;
    }
    const hardware = await DeviceInfo.getHardware();
    const model = DeviceInfo.getModel();
    const socModel = await this.fetchSoCModel();
    const vendor = this.detectAndroidVendor(hardware.toLowerCase(), model, socModel);
    const qnnVariant = vendor === 'qualcomm' ? await this.getQnnVariantFromSoC(socModel) : undefined;
    const exynosVariant = vendor === 'exynos' ? await this.getExynosVariantFromSoC(socModel) : undefined;
    // Exynos Maia NPU has no public SDK — hasNPU stays false; GPU tier drives OpenCL path
    const exynosGpuTier = exynosVariant === 'exynos2400' ? 'mali-g720'
      : exynosVariant === 'exynos2200' ? 'mali-g615'
      : exynosVariant ? 'unknown' as const
      : undefined;
    this.cachedSoCInfo = { vendor, hasNPU: vendor === 'qualcomm' && !!qnnVariant, qnnVariant, exynosVariant, exynosGpuTier };
    return this.cachedSoCInfo;
  }

  private async getQnnVariantFromSoC(
    socModelOverride?: string,
  ): Promise<'8gen2' | '8gen1' | 'min' | undefined> {
    const socModel = socModelOverride || await this.fetchSoCModel();
    if (!socModel) return undefined;
    return this.classifySmNumber(socModel);
  }

  private async fetchSoCModel(): Promise<string> {
    try {
      const localDream = getLocalDreamModule();
      if (localDream?.getSoCModel) return await localDream.getSoCModel();
    } catch { /* native module unavailable */ }
    return '';
  }

  private classifySmNumber(socModel: string): '8gen2' | '8gen1' | 'min' | undefined {
    const base = socModel.split('-')[0].toUpperCase();
    // Must start with SM — matches local-dream's getChipsetSuffix fallback
    if (!base.startsWith('SM')) return undefined;
    const smMatch = /^SM(\d+)/.exec(base);
    if (!smMatch) return undefined;
    const num = parseInt(smMatch[1], 10);
    if (FLAGSHIP_8GEN2.has(num)) return '8gen2';
    if (FLAGSHIP_8GEN1.has(num)) return '8gen1';
    return 'min';
  }

  private classifyExynosVariant(
    socModel: string,
  ): 'exynos2400' | 'exynos2200' | 'exynos2100' | undefined {
    const upper = socModel.toUpperCase();
    const match = EXYNOS_SOC_VARIANTS.find(v => upper.startsWith(v.prefix));
    return match?.variant;
  }

  private async getExynosVariantFromSoC(
    socModelOverride?: string,
  ): Promise<'exynos2400' | 'exynos2200' | 'exynos2100' | undefined> {
    const socModel = socModelOverride || await this.fetchSoCModel();
    if (!socModel) return undefined;
    return this.classifyExynosVariant(socModel);
  }

  private getExynosImageRec(socInfo: SoCInfo): ImageModelRecommendation {
    // Mali-G720 (Exynos 2400 / Galaxy S24) supports OpenCL 3.0 for LLM GPU acceleration.
    // SD subprocess does not ship OpenCL/Vulkan — image gen stays on MNN CPU for all Exynos.
    const label = socInfo.exynosVariant === 'exynos2400' ? 'Exynos 2400 (Mali-G720)'
      : socInfo.exynosVariant === 'exynos2200' ? 'Exynos 2200' : 'Exynos';
    if (socInfo.exynosGpuTier === 'mali-g720') {
      return {
        recommendedBackend: 'mnn',
        bannerText: `${label} — chat uses GPU (OpenCL); image models use CPU (MNN)`,
        compatibleBackends: ['mnn'],
      };
    }
    return {
      recommendedBackend: 'mnn',
      bannerText: `${label} — image models use CPU (MNN)`,
      compatibleBackends: ['mnn'],
    };
  }

  private getIosImageRec(chip: SoCInfo['appleChip'], ramGB: number): ImageModelRecommendation {
    if ((chip === 'A17Pro' || chip === 'A18') && ramGB >= 6) {
      return { recommendedBackend: 'coreml', recommendedModels: ['sdxl', 'xl-base'], bannerText: 'All models supported \u2014 SDXL for best quality', compatibleBackends: ['coreml'] };
    }
    if ((chip === 'A15' || chip === 'A16') && ramGB >= 6) {
      return { recommendedBackend: 'coreml', recommendedModels: ['v1-5-palettized', '2-1-base-palettized'], bannerText: 'SD 1.5 or SD 2.1 Palettized recommended', compatibleBackends: ['coreml'] };
    }
    return { recommendedBackend: 'coreml', recommendedModels: ['v1-5-palettized'], bannerText: 'SD 1.5 Palettized recommended for your device', compatibleBackends: ['coreml'] };
  }

  private getQualcommImageRec(socInfo: SoCInfo): ImageModelRecommendation {
    const label = socInfo.qnnVariant === '8gen2' ? 'flagship' : socInfo.qnnVariant === '8gen1' ? '' : 'lightweight ';
    const suffix = socInfo.qnnVariant === '8gen2' ? 'NPU models for fastest inference' : socInfo.qnnVariant === '8gen1' ? 'NPU models supported' : 'lightweight NPU models recommended';
    return { recommendedBackend: 'qnn', qnnVariant: socInfo.qnnVariant, bannerText: `Snapdragon ${label}\u2014 ${suffix}`, compatibleBackends: ['qnn', 'mnn'] };
  }

  async getImageModelRecommendation(): Promise<ImageModelRecommendation> {
    if (this.cachedImageRecommendation) return this.cachedImageRecommendation;
    const socInfo = await this.getSoCInfo();
    const ramGB = this.getTotalMemoryGB();
    let rec: ImageModelRecommendation;
    if (Platform.OS === 'ios') {
      rec = this.getIosImageRec(socInfo.appleChip, ramGB);
    } else if (socInfo.vendor === 'qualcomm' && socInfo.hasNPU) {
      rec = this.getQualcommImageRec(socInfo);
    } else if (socInfo.vendor === 'qualcomm') {
      rec = { recommendedBackend: 'mnn', bannerText: 'CPU models recommended — your Snapdragon doesn\u2019t support NPU acceleration', compatibleBackends: ['mnn'] };
    } else if (socInfo.vendor === 'exynos') {
      rec = this.getExynosImageRec(socInfo);
    } else {
      rec = { recommendedBackend: 'mnn', bannerText: 'CPU models recommended — NPU requires Snapdragon 888+', compatibleBackends: ['mnn'] };
    }
    if (ramGB < 4) { rec.warning = 'Low RAM \u2014 expect slower performance'; }
    this.cachedImageRecommendation = rec;
    return rec;
  }

  getDeviceTier(): 'low' | 'medium' | 'high' | 'flagship' {
    const ramGB = this.getTotalMemoryGB();
    if (ramGB < 4) return 'low';
    if (ramGB < 6) return 'medium';
    if (ramGB < 8) return 'high';
    return 'flagship';
  }
}

export const hardwareService = new HardwareService();
