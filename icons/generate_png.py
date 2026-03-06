import os
import cairosvg

# Пути к SVG и PNG файлам
svg_dir = 'icons'
png_dir = 'icons'

# Размеры иконок
sizes = [16, 48, 128]

for size in sizes:
    svg_path = os.path.join(svg_dir, f'icon{size}.svg')
    png_path = os.path.join(png_dir, f'icon{size}.png')
    
    # Конвертируем SVG в PNG
    cairosvg.svg2png(url=svg_path, write_to=png_path, output_width=size, output_height=size)
    print(f"Created {png_path}")