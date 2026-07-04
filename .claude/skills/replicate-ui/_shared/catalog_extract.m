// catalog_extract — extract a native macOS app's icons from its compiled asset catalog
// (Assets.car) as clean, TRANSPARENT PNGs. Our own code calling macOS's built-in CoreUI
// (the same private framework Apple's `assetutil` uses); no third-party code, read-only on
// the app bundle.
//
// WHY: AppKit apps (Office, Finder, Mail, …) ship their toolbar/ribbon icons in Assets.car.
// Extracting them gives crisp, background-free, scalable icons — far better than cropping a
// screenshot (which bakes in the ribbon background). See SKILL.md step 3b (native-app icon path).
//
// BUILD (once per machine; gitignored binary):
//   clang -fobjc-arc -framework Foundation -framework CoreGraphics -framework ImageIO \
//         catalog_extract.m -o catalog_extract
// RUN:
//   ./catalog_extract <Assets.car> <out_dir> [name_substring_filter]
//   - no filter  → every icon; filter (e.g. "ic_fluent_text_bold") → just matches.
//   - writes <out_dir>/<name>.<scale>x.<WxH>.png  (only @2x renditions, ~icon sizes).
// Filenames keep the catalog base name so callers can name-match (see native_icons.py).
//
// Find an app's catalogs:  find /Applications/<App>.app -name '*.car'
//   (Office ribbon icons live in Contents/Frameworks/mso40ui.framework/.../Assets.car)
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <dlfcn.h>

// CoreUI interfaces (declared so the compiler knows the selectors; the class is resolved at
// runtime via NSClassFromString after dlopen, so we never link the private framework).
@interface CUINamedImage : NSObject
@property (readonly) CGImageRef image;
@property (readonly) double scale;
@property (readonly) NSString *name;
@end
@interface CUICatalog : NSObject
- (instancetype)initWithURL:(NSURL *)url error:(NSError **)error;
- (NSArray<NSString *> *)allImageNames;
- (NSArray *)imagesWithName:(NSString *)name;
@end

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc < 3) { fprintf(stderr, "usage: catalog_extract <Assets.car> <outdir> [name-filter]\n"); return 2; }
    NSString *carPath = [NSString stringWithUTF8String:argv[1]];
    NSString *outDir  = [NSString stringWithUTF8String:argv[2]];
    NSString *filter  = (argc > 3) ? [NSString stringWithUTF8String:argv[3]] : nil;
    if (filter.length == 0) filter = nil;   // empty filter = match ALL names

    if (!dlopen("/System/Library/PrivateFrameworks/CoreUI.framework/CoreUI", RTLD_NOW)) {
      fprintf(stderr, "dlopen CoreUI failed\n"); return 1;
    }
    Class CatClass = NSClassFromString(@"CUICatalog");
    if (!CatClass) { fprintf(stderr, "no CUICatalog class\n"); return 1; }

    NSError *err = nil;
    CUICatalog *cat = [[CatClass alloc] initWithURL:[NSURL fileURLWithPath:carPath] error:&err];
    if (!cat) { fprintf(stderr, "open failed: %s\n", err.description.UTF8String); return 1; }

    NSArray<NSString *> *names = [cat allImageNames];
    [[NSFileManager defaultManager] createDirectoryAtPath:outDir withIntermediateDirectories:YES attributes:nil error:nil];

    int matched = 0, saved = 0;
    for (NSString *name in names) {
      if (filter && [name rangeOfString:filter options:NSCaseInsensitiveSearch].location == NSNotFound) continue;
      matched++;
      for (CUINamedImage *ni in [cat imagesWithName:name]) {
        CGImageRef cg = NULL;
        @try { cg = ni.image; } @catch (...) { cg = NULL; }
        if (!cg) continue;
        double scale = 1.0; @try { scale = ni.scale; } @catch (...) {}
        size_t w = CGImageGetWidth(cg), h = CGImageGetHeight(cg);
        // Keep @2x renditions across the icon-size range (16/18/20/30/32 pt → 32..64 px), with a
        // little margin. Includes the LARGEST rendition so callers can downscale for crisp icons.
        if (scale != 2.0) continue;
        if (w < 20 || w > 80 || h < 20 || h > 80) continue;
        NSString *safe = [name stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
        NSString *file = [NSString stringWithFormat:@"%@/%@.%gx.%zux%zu.png", outDir, safe, scale, w, h];
        CGImageDestinationRef dst = CGImageDestinationCreateWithURL(
            (__bridge CFURLRef)[NSURL fileURLWithPath:file], CFSTR("public.png"), 1, NULL);
        if (dst) { CGImageDestinationAddImage(dst, cg, NULL);
                   if (CGImageDestinationFinalize(dst)) saved++; CFRelease(dst); }
      }
    }
    fprintf(stdout, "names_total=%lu matched=%d saved=%d\n", (unsigned long)names.count, matched, saved);
  }
  return 0;
}
