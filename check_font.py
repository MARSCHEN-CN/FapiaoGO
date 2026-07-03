with open('frontend/public/fonts/MiSans-Regular.woff2', 'rb') as f:
    data = f.read(12)
    print(' '.join(['%02X' % b for b in data]))