import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import {
  ImageGenerationParams,
  ImageGenerationProgress,
  GeneratedImage,
} from '../types';
import { generateRandomSeed } from '../utils/generateId';

const { LocalDreamModule, CoreMLDiffusionModule, ExynosNpuDiffusionModule } = NativeModules;

type DiffusionBackend = 'mnn' | 'qnn' | 'opencl' | 'one' | 'auto';
type DiffusionModuleType = {
  loadModel: (params: { modelPath: string; threads?: number; backend: string }) => Promise<boolean>;
  unloadModel: () => Promise<boolean>;
  isModelLoaded: () => Promise<boolean>;
  getLoadedModelPath: () => Promise<string | null>;
  generateImage: (params: Record<string, unknown>) => Promise<any>;
  cancelGeneration: () => Promise<boolean>;
  isGenerating: () => Promise<boolean>;
  getGeneratedImages: () => Promise<any[]>;
  deleteGeneratedImage: (imageId: string) => Promise<boolean>;
  getConstants: () => any;
};

type ProgressCallback = (progress: ImageGenerationProgress) => void;
type PreviewCallback = (preview: { previewPath: string; step: number; totalSteps: number }) => void;

/**
 * LocalDream-based image generator service.
 * Replaces ONNX Runtime with local-dream's subprocess HTTP server.
 *
 * The native module (LocalDreamModule) manages:
 * - Server process lifecycle (spawn/kill)
 * - HTTP POST + SSE parsing for image generation
 * - RGB→PNG conversion and file management
 *
 * Progress events are emitted via NativeEventEmitter from the native side.
 */
class LocalDreamGeneratorService {
  private loadedThreads: number | null = null;
  private generating = false;
  private eventEmitter: NativeEventEmitter | null = null;
  private activeModule: DiffusionModuleType | null = null;

  private getFallbackModule(): DiffusionModuleType | null {
    return Platform.select({
      ios: CoreMLDiffusionModule,
      android: LocalDreamModule,
      default: null,
    }) as DiffusionModuleType | null;
  }

  private getModuleForBackend(backend: DiffusionBackend): DiffusionModuleType | null {
    if (Platform.OS === 'ios') {
      return CoreMLDiffusionModule as DiffusionModuleType | null;
    }
    if (Platform.OS !== 'android') {
      return null;
    }
    if (backend === 'one') {
      return (ExynosNpuDiffusionModule as DiffusionModuleType | null) ?? null;
    }
    return (LocalDreamModule as DiffusionModuleType | null) ?? null;
  }

  private async resolveActiveModule(): Promise<DiffusionModuleType | null> {
    if (this.activeModule) {
      return this.activeModule;
    }
    if (Platform.OS !== 'android') {
      return this.getFallbackModule();
    }

    const candidates = [
      ExynosNpuDiffusionModule as DiffusionModuleType | undefined,
      LocalDreamModule as DiffusionModuleType | undefined,
    ].filter(Boolean) as DiffusionModuleType[];

    for (const module of candidates) {
      try {
        if (await module.isModelLoaded()) {
          this.activeModule = module;
          return module;
        }
      } catch {
        // Probe the next module.
      }
    }

    return this.getFallbackModule();
  }

  private getEmitter(module: DiffusionModuleType): NativeEventEmitter {
    if (!this.eventEmitter) {
      this.eventEmitter = new NativeEventEmitter(module as any);
    }
    return this.eventEmitter;
  }

  isAvailable(): boolean {
    if (Platform.OS === 'android') {
      return LocalDreamModule != null || ExynosNpuDiffusionModule != null;
    }
    return this.getFallbackModule() != null;
  }

  async isModelLoaded(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    try {
      const module = await this.resolveActiveModule();
      if (!module) return false;
      return await module.isModelLoaded();
    } catch {
      return false;
    }
  }

  async getLoadedModelPath(): Promise<string | null> {
    if (!this.isAvailable()) return null;
    try {
      const module = await this.resolveActiveModule();
      if (!module) return null;
      return await module.getLoadedModelPath();
    } catch {
      return null;
    }
  }

  async loadModel(modelPath: string, threads?: number, backend: DiffusionBackend = 'auto'): Promise<boolean> {
    if (!this.isAvailable()) {
      throw new Error('LocalDream image generation is not available on this platform');
    }
    const module = this.getModuleForBackend(backend);
    if (!module) {
      throw new Error(`No native diffusion module is available for backend: ${backend}`);
    }

    const params: { modelPath: string; threads?: number; backend: string } = {
      modelPath,
      backend,
    };
    if (typeof threads === 'number') {
      params.threads = threads;
    }

    const result = await module.loadModel(params);
    this.activeModule = module;
    this.eventEmitter = null;
    this.loadedThreads = typeof threads === 'number' ? threads : this.loadedThreads;
    return result;
  }

  getLoadedThreads(): number | null {
    return this.loadedThreads;
  }

  async unloadModel(): Promise<boolean> {
    if (!this.isAvailable()) return true;
    const module = await this.resolveActiveModule();
    if (!module) return true;
    const result = await module.unloadModel();
    this.activeModule = null;
    this.eventEmitter = null;
    this.loadedThreads = null;
    return result;
  }

  private subscribeToProgress(
    module: DiffusionModuleType,
    onProgress?: ProgressCallback,
    onPreview?: PreviewCallback,
  ): any {
    return this.getEmitter(module).addListener(
      'LocalDreamProgress',
      (event: { step: number; totalSteps: number; progress: number; previewPath?: string }) => {
        onProgress?.({
          step: event.step,
          totalSteps: event.totalSteps,
          progress: event.progress,
        });
        if (event.previewPath && onPreview) {
          onPreview({ previewPath: event.previewPath, step: event.step, totalSteps: event.totalSteps });
        }
      },
    );
  }

  async generateImage(
    params: ImageGenerationParams & { previewInterval?: number },
    onProgress?: ProgressCallback,
    onPreview?: PreviewCallback,
  ): Promise<GeneratedImage> {
    if (!this.isAvailable()) {
      throw new Error('LocalDream image generation is not available on this platform');
    }

    if (this.generating) {
      throw new Error('Image generation already in progress');
    }

    const module = await this.resolveActiveModule();
    if (!module) {
      throw new Error('No active diffusion module is loaded');
    }

    this.generating = true;
    const progressSubscription = this.subscribeToProgress(module, onProgress, onPreview);

    try {
      // Call native generateImage — handles HTTP POST, SSE parsing, and PNG saving
      const result = await module.generateImage({
        prompt: params.prompt,
        negativePrompt: params.negativePrompt || '',
        steps: params.steps || 20,
        guidanceScale: params.guidanceScale || 7.5,
        seed: params.seed ?? generateRandomSeed(),
        width: params.width || 512,
        height: params.height || 512,
        previewInterval: params.previewInterval ?? 2,
      });

      return {
        id: result.id,
        prompt: params.prompt,
        negativePrompt: params.negativePrompt,
        imagePath: result.imagePath,
        width: result.width,
        height: result.height,
        steps: params.steps || 20,
        seed: result.seed,
        modelId: '',
        createdAt: Date.now().toString(),
      };
    } finally {
      this.generating = false;
      progressSubscription?.remove();
    }
  }

  async cancelGeneration(): Promise<boolean> {
    if (!this.isAvailable()) return true;
    this.generating = false;
    const module = await this.resolveActiveModule();
    if (!module) return true;
    return await module.cancelGeneration();
  }

  async isGenerating(): Promise<boolean> {
    return this.generating;
  }

  async getGeneratedImages(): Promise<GeneratedImage[]> {
    if (!this.isAvailable()) return [];
    try {
      const module = await this.resolveActiveModule();
      if (!module) return [];
      const images = await module.getGeneratedImages();
      return images.map((img: any) => ({
        id: img.id,
        prompt: img.prompt || '',
        imagePath: img.imagePath,
        width: img.width || 512,
        height: img.height || 512,
        steps: img.steps || 20,
        seed: img.seed || 0,
        modelId: img.modelId || '',
        createdAt: img.createdAt,
      }));
    } catch {
      return [];
    }
  }

  async deleteGeneratedImage(imageId: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    const module = await this.resolveActiveModule();
    if (!module) return false;
    return await module.deleteGeneratedImage(imageId);
  }

  getConstants() {
    const module = this.activeModule ?? this.getFallbackModule();
    if (!this.isAvailable() || !module) {
      return {
        DEFAULT_STEPS: 20,
        DEFAULT_GUIDANCE_SCALE: 7.5,
        DEFAULT_WIDTH: 512,
        DEFAULT_HEIGHT: 512,
        SUPPORTED_WIDTHS: [128, 192, 256, 320, 384, 448, 512],
        SUPPORTED_HEIGHTS: [128, 192, 256, 320, 384, 448, 512],
      };
    }
    return module.getConstants();
  }
}

export const localDreamGeneratorService = new LocalDreamGeneratorService();
