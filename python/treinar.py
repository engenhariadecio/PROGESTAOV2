#!/usr/bin/env python3
"""
Treina o detector de caixas/peças de uma câmera a partir das amostras marcadas no painel.

  python3 treinar.py --dados PASTA --saida modelo.onnx [--epocas 40] [--imgsz 416]

PASTA/images/*.jpg + PASTA/labels/*.txt (formato YOLO, classe 0 = objeto).
Parte dos pesos yolov8n-oiv7 (Open Images, que já conhece "Box") e ajusta para
as caixas/peças desta linha. Imprime linhas "PROGRESSO n/total" e, no fim,
"METRICAS {json}" — o servidor acompanha por aí.
"""
import argparse, json, os, sys, shutil, glob

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dados', required=True); ap.add_argument('--saida', required=True)
    ap.add_argument('--base', default=os.path.join(os.path.dirname(__file__), 'pesos', 'yolov8n-oiv7.pt'))
    ap.add_argument('--epocas', type=int, default=40); ap.add_argument('--imgsz', type=int, default=416)
    ap.add_argument('--batch', type=int, default=8)
    a = ap.parse_args()

    try:
        from ultralytics import YOLO
    except ImportError:
        print('ERRO ultralytics não instalado (pip install -r python/requirements.txt)'); sys.exit(2)

    imgs = sorted(glob.glob(os.path.join(a.dados, 'images', '*.jpg')))
    if len(imgs) < 3: print('ERRO poucas amostras (mínimo 3 quadros marcados)'); sys.exit(3)
    yaml = os.path.join(a.dados, 'data.yaml')
    with open(yaml, 'w') as f:
        f.write(f"path: {os.path.abspath(a.dados)}\ntrain: images\nval: images\nnames:\n  0: objeto\n")

    run_dir = os.path.join(a.dados, 'run')
    shutil.rmtree(run_dir, ignore_errors=True)
    model = YOLO(a.base)
    total = a.epocas
    def on_epoch_end(trainer):
        print(f'PROGRESSO {trainer.epoch + 1}/{total}', flush=True)
    model.add_callback('on_train_epoch_end', on_epoch_end)
    model.train(data=yaml, epochs=a.epocas, imgsz=a.imgsz, batch=a.batch, device='cpu', workers=0,
                project=run_dir, name='t', exist_ok=True, verbose=False, plots=False, val=True,
                pretrained=True, patience=0, close_mosaic=max(1, a.epocas // 4),
                # aumentos leves: a câmera é fixa, mas luz, tremida e posição mudam
                hsv_h=0.01, hsv_s=0.4, hsv_v=0.4, degrees=3, translate=0.08, scale=0.25, fliplr=0.5, mosaic=1.0)
    best = os.path.join(run_dir, 't', 'weights', 'best.pt')
    if not os.path.exists(best): best = os.path.join(run_dir, 't', 'weights', 'last.pt')
    m = YOLO(best)
    met = {}
    try:
        r = m.val(data=yaml, imgsz=a.imgsz, device='cpu', workers=0, plots=False, verbose=False)
        met = {'map50': round(float(r.box.map50), 3), 'map': round(float(r.box.map), 3), 'precisao': round(float(r.box.mp), 3), 'recall': round(float(r.box.mr), 3)}
    except Exception as e:
        met = {'erro_val': str(e)[:200]}
    onnx = m.export(format='onnx', imgsz=a.imgsz, opset=12, simplify=False, dynamic=False, device='cpu')
    shutil.copy(onnx, a.saida)
    met['imagens'] = len(imgs); met['imgsz'] = a.imgsz; met['epocas'] = a.epocas
    print('METRICAS ' + json.dumps(met), flush=True)

if __name__ == '__main__':
    main()
