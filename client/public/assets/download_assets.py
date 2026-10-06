import urllib.request
import re
import os
import zipfile

url = 'https://kenney.nl/assets/space-shooter-redux'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
try:
    resp = urllib.request.urlopen(req).read().decode('utf-8')
    match = re.search(r'href=[\'"]([^\'"]+?\.zip)[\'"]', resp)
    if match:
        download_url = match.group(1)
        if not download_url.startswith('http'):
            download_url = 'https://kenney.nl' + download_url
        print('Found zip:', download_url)
        zip_path = 'pack.zip'
        urllib.request.urlretrieve(download_url, zip_path)
        print('Downloaded zip.')
        
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            for file in zip_ref.namelist():
                if file.endswith('.png'):
                    if 'playerShip1_blue' in file:
                        zip_ref.extract(file, 'extracted')
                        os.rename(f'extracted/{file}', 'player.png')
                    elif 'enemyRed1' in file:
                        zip_ref.extract(file, 'extracted')
                        os.rename(f'extracted/{file}', 'enemy_fighter.png')
                    elif 'enemyYellow3' in file:
                        zip_ref.extract(file, 'extracted')
                        os.rename(f'extracted/{file}', 'enemy_bomber.png')
                    elif 'laserBlue01.png' in file:
                        zip_ref.extract(file, 'extracted')
                        os.rename(f'extracted/{file}', 'projectile.png')
        print('Assets extracted.')
    else:
        print('No zip found')
except Exception as e:
    print(e)
